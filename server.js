const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const archiver = require('archiver');

const app = express();
const port = process.env.PORT || 3000;
app.set('trust proxy', 1); // Render sits behind a proxy; this makes req.ip reliable.

// Enable CORS for Angular
app.use(cors());

// Configure Multer for file uploads
const upload = multer({ dest: 'uploads/' });

// --- THROTTLING ---
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || `${15 * 60 * 1000}`, 10);
const MAX_REQUESTS_PER_WINDOW = parseInt(process.env.RATE_LIMIT_MAX || '60', 10);
const HEAVY_MAX_REQUESTS_PER_WINDOW = parseInt(process.env.HEAVY_RATE_LIMIT_MAX || '10', 10);
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS || '2', 10);

const globalIpHits = new Map();
const heavyIpHits = new Map();
let activeHeavyJobs = 0;

const getIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

const clearExpired = (store, now, windowMs) => {
  for (const [key, bucket] of store.entries()) {
    if (now - bucket.windowStart >= windowMs) store.delete(key);
  }
};

const createIpRateLimiter = ({ store, maxRequests, windowMs, message }) => {
  return (req, res, next) => {
    const now = Date.now();
    const ip = getIp(req);

    clearExpired(store, now, windowMs);

    const existing = store.get(ip);
    if (!existing || now - existing.windowStart >= windowMs) {
      store.set(ip, { count: 1, windowStart: now });
      return next();
    }

    existing.count += 1;
    if (existing.count > maxRequests) {
      const retryAfterSeconds = Math.ceil((windowMs - (now - existing.windowStart)) / 1000);
      res.set('Retry-After', String(Math.max(retryAfterSeconds, 1)));
      return res.status(429).send(message);
    }

    return next();
  };
};

const globalRateLimit = createIpRateLimiter({
  store: globalIpHits,
  maxRequests: MAX_REQUESTS_PER_WINDOW,
  windowMs: WINDOW_MS,
  message: 'Too many requests. Please try again later.',
});

const heavyRouteRateLimit = createIpRateLimiter({
  store: heavyIpHits,
  maxRequests: HEAVY_MAX_REQUESTS_PER_WINDOW,
  windowMs: WINDOW_MS,
  message: 'Too many conversion requests. Please wait and retry.',
});

const limitConcurrentHeavyJobs = (req, res, next) => {
  if (activeHeavyJobs >= MAX_CONCURRENT_JOBS) {
    res.set('Retry-After', '10');
    return res.status(429).send('Server is busy. Please retry shortly.');
  }

  activeHeavyJobs += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeHeavyJobs = Math.max(activeHeavyJobs - 1, 0);
  };

  res.on('finish', release);
  res.on('close', release);
  next();
};

app.use(globalRateLimit);

// --- HELPER FUNCTIONS ---

const getFileSizeMB = (path) => {
  try {
    const stats = fs.statSync(path);
    return stats.size / (1024 * 1024);
  } catch (e) {
    return 0;
  }
};

const cleanup = (input, output = null, extraDir = null) => {
  try {
    if (input && fs.existsSync(input)) fs.unlinkSync(input);
    if (output && fs.existsSync(output)) fs.unlinkSync(output);
    if (extraDir && fs.existsSync(extraDir)) fs.rmSync(extraDir, { recursive: true, force: true });
  } catch (e) {
    console.error('Cleanup warning:', e.message);
  }
};

// Check if the error was caused by a missing/wrong password
const checkPasswordError = (stderr, stdout) => {
  const output = (stderr + stdout).toLowerCase();
  return output.includes('password') || output.includes('encrypted') || output.includes('this file requires a password');
};

// --- ROUTES ---

app.get('/', (req, res) => {
  res.send('PDF Converter Backend is Running!');
});

// 1. CONVERT ROUTE (RGB -> CMYK)
app.post('/convert', heavyRouteRateLimit, limitConcurrentHeavyJobs, upload.single('pdfFile'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');

  const inputPath = req.file.path;
  const outputPath = `uploads/output_${req.file.filename}.pdf`;
  const password = req.body.password || '';

  // Add password flag if provided
  const passFlag = password ? `-sPDFPassword="${password}"` : '';

  const gsCommand = `gs -dSAFER -dBATCH -dNOPAUSE -dNOCACHE -sDEVICE=pdfwrite -sColorConversionStrategy=CMYK -dProcessColorModel=/DeviceCMYK ${passFlag} -sOutputFile="${outputPath}" "${inputPath}"`;

  console.log('Converting file...');

  exec(gsCommand, (error, stdout, stderr) => {
    // 1. Check for Password Error
    if (checkPasswordError(stderr, stdout)) {
      cleanup(inputPath, outputPath);
      return res.status(401).send('PASSWORD_REQUIRED');
    }

    // 2. Check for General Error
    if (error) {
      console.error(`Convert exec error: ${error}`);
      cleanup(inputPath, outputPath);
      return res.status(500).send('Error converting file.');
    }

    // 3. Success
    res.download(outputPath, 'converted-cmyk.pdf', (err) => {
      cleanup(inputPath, outputPath);
    });
  });
});

// 2. COMPRESS ROUTE
app.post('/compress', heavyRouteRateLimit, limitConcurrentHeavyJobs, upload.single('pdfFile'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');

  const inputPath = req.file.path;
  const outputPath = `uploads/compressed_${req.file.filename}.pdf`;
  const originalSize = getFileSizeMB(inputPath);
  
  const mode = req.body.mode; 
  const value = parseFloat(req.body.value);
  const password = req.body.password || '';

  let gsSettings = '/ebook';

  // Strategy Logic
  if (mode === 'target') {
    const requiredRatio = value / originalSize;
    if (requiredRatio >= 1) gsSettings = '/printer';
    else if (requiredRatio < 0.2) gsSettings = '/screen'; 
    else if (requiredRatio < 0.6) gsSettings = '/ebook';
    else gsSettings = '/printer';
  } else if (mode === 'percentage') {
    if (value > 75) gsSettings = '/prepress';
    else if (value > 50) gsSettings = '/printer';
    else if (value > 25) gsSettings = '/ebook';
    else gsSettings = '/screen';
  }

  // Add password flag
  const passFlag = password ? `-sPDFPassword="${password}"` : '';

  const gsCommand = `gs -dSAFER -dBATCH -dNOPAUSE -dNOCACHE -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${gsSettings} ${passFlag} -sOutputFile="${outputPath}" "${inputPath}"`;

  console.log(`Compressing with settings ${gsSettings}`);

  exec(gsCommand, (error, stdout, stderr) => {
    // 1. Check for Password Error
    if (checkPasswordError(stderr, stdout)) {
      cleanup(inputPath, outputPath);
      return res.status(401).send('PASSWORD_REQUIRED');
    }

    // 2. Check for General Error
    if (error) {
      console.error(`Compress exec error: ${error}`);
      cleanup(inputPath, outputPath);
      return res.status(500).send('Compression failed.');
    }

    // 3. Success
    const newSize = getFileSizeMB(outputPath);
    res.set('X-Original-Size', originalSize.toFixed(2));
    res.set('X-New-Size', newSize.toFixed(2));

    res.download(outputPath, 'compressed.pdf', (err) => {
      cleanup(inputPath, outputPath);
    });
  });
});

// 3. EXTRACT ROUTE
app.post('/extract', heavyRouteRateLimit, limitConcurrentHeavyJobs, upload.single('pdfFile'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');

  const inputPath = req.file.path;
  const outputDir = `uploads/extract_${Date.now()}`;
  
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  const mode = req.body.mode || 'images';
  const format = req.body.format || 'png';
  const password = req.body.password || '';

  console.log(`Extracting: Mode=${mode}, Format=${format}`);

  const outputPrefix = `${outputDir}/output`;
  let cmd = '';

  if (mode === 'pages') {
    // Ghostscript for Pages
    let device = 'png16m';
    if (format === 'jpg') device = 'jpeg';
    if (format === 'tiff') device = 'tiff24nc';

    const outputFile = `${outputPrefix}-%03d.${format}`;
    const passFlag = password ? `-sPDFPassword="${password}"` : '';
    
    cmd = `gs -dSAFER -dBATCH -dNOPAUSE -sDEVICE=${device} ${passFlag} -r150 -sOutputFile="${outputFile}" "${inputPath}"`;
  } 
  else {
    // pdfimages for Embedded Images
    let formatFlag = '-png';
    if (format === 'jpg') formatFlag = '-j';
    if (format === 'tiff') formatFlag = '-tiff';

    // pdfimages uses -opw for owner password or -upw for user password. 
    // Usually -upw is what users have.
    const passFlag = password ? `-upw "${password}"` : '';

    cmd = `pdfimages ${formatFlag} ${passFlag} "${inputPath}" "${outputPrefix}"`;
  }

  exec(cmd, (error, stdout, stderr) => {
    // 1. Check for Password Error
    if (checkPasswordError(stderr, stdout)) {
      cleanup(inputPath, null, outputDir);
      return res.status(401).send('PASSWORD_REQUIRED');
    }

    // 2. Check for General Error
    if (error) {
      console.error(`Extract exec error: ${error}`);
      cleanup(inputPath, null, outputDir);
      return res.status(500).send('Processing failed.');
    }

    // 3. Validate Output
    const extractedFiles = fs.readdirSync(outputDir);
    if (extractedFiles.length === 0) {
      cleanup(inputPath, null, outputDir);
      const msg = mode === 'images' 
        ? 'No embedded images found. Try "Extract Pages" instead.' 
        : 'Could not render pages.';
      return res.status(422).send(msg);
    }

    // 4. Zip and Send
    const zipPath = `${outputDir}.zip`;
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      const filename = mode === 'pages' ? `pages_${format}.zip` : `images_${format}.zip`;
      res.download(zipPath, filename, (err) => {
        cleanup(inputPath, zipPath, outputDir);
      });
    });

    archive.on('error', (err) => {
      cleanup(inputPath, zipPath, outputDir);
      res.status(500).send('Zip creation failed.');
    });

    archive.pipe(output);
    archive.directory(outputDir, false);
    archive.finalize();
  });
});

// 4. UNLOCK ROUTE (Remove Password)
app.post('/unlock', heavyRouteRateLimit, limitConcurrentHeavyJobs, upload.single('pdfFile'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  
  const inputPath = req.file.path;
  const outputPath = `uploads/unlocked_${req.file.filename}.pdf`;
  const password = req.body.password;

  if (!password) {
    cleanup(inputPath);
    return res.status(400).send('Password is required.');
  }

  // Ghostscript command to decrypt
  // We pass the password. The output will be a standard, unencrypted PDF.
  const gsCommand = `gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sPDFPassword="${password}" -sOutputFile="${outputPath}" "${inputPath}"`;

  console.log('Unlocking file...');

  exec(gsCommand, (error, stdout, stderr) => {
    // Check if Ghostscript failed (likely wrong password)
    if (error || stderr.toLowerCase().includes('password')) {
      console.error(`Unlock failed: ${stderr}`);
      cleanup(inputPath, outputPath);
      return res.status(401).send('Incorrect Password or File Error');
    }

    // Success
    console.log('File unlocked successfully.');
    res.download(outputPath, 'unlocked.pdf', (err) => {
      cleanup(inputPath, outputPath);
    });
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
});
