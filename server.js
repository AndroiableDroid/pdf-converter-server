const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for Angular
app.use(cors());

// Configure Multer for file uploads
const upload = multer({ dest: 'uploads/' });

app.get('/', (req, res) => {
  res.send('PDF Converter Backend is Running!');
});

app.post('/convert', upload.single('pdfFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  const inputPath = req.file.path;
  const outputPath = `uploads/output_${req.file.filename}.pdf`;

  // Ghostscript command to convert RGB to CMYK
  // Note: 'gs' is for Linux/Mac. On Windows, typically use 'gswin64c' or just 'gswin64'
  const gsCommand = `gs -dSAFER -dBATCH -dNOPAUSE -dNOCACHE -sDEVICE=pdfwrite -sColorConversionStrategy=CMYK -dProcessColorModel=/DeviceCMYK -sOutputFile="${outputPath}" "${inputPath}"`;

  console.log('Processing file...');

  exec(gsCommand, (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error: ${error}`);
      return res.status(500).send('Error converting file.');
    }

    // Send the converted file back to the client
    res.download(outputPath, 'converted-cmyk.pdf', (err) => {
      if (err) console.error(err);

      // Cleanup: Delete temporary files
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    });
    console.log("Done Processing");
  });
});

// ... existing imports ...

// Helper: Get file size in MB
const getFileSizeMB = (path) => {
  const stats = fs.statSync(path);
  return stats.size / (1024 * 1024);
};

// COMPRESSION ROUTE
app.post('/compress', upload.single('pdfFile'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');

  const inputPath = req.file.path;
  const outputPath = `uploads/compressed_${req.file.filename}.pdf`;
  const originalSize = getFileSizeMB(inputPath);
  
  // Inputs from frontend
  const mode = req.body.mode; // 'percentage' or 'target'
  const value = parseFloat(req.body.value); // e.g., 50 (percent) or 2.5 (MB)

  let gsSettings = '/ebook'; // Default fallback

  // --- LOGIC: Select Ghostscript Profile ---
  
  if (mode === 'target') {
    const targetSize = value;
    const requiredRatio = targetSize / originalSize;

    if (requiredRatio >= 1) {
       // Target is bigger than original; just do light cleanup
       gsSettings = '/printer';
    } else if (requiredRatio < 0.2) {
       // Extreme compression needed (Target is < 20% of original)
       gsSettings = '/screen'; 
    } else if (requiredRatio < 0.6) {
       // Moderate compression needed
       gsSettings = '/ebook';
    } else {
       // Light compression needed
       gsSettings = '/printer';
    }
  } 
  
  else if (mode === 'percentage') {
    // Value represents "Quality Percentage" (100 = Best, 0 = Smallest)
    if (value > 75) gsSettings = '/prepress';     // High Quality
    else if (value > 50) gsSettings = '/printer'; // Medium-High
    else if (value > 25) gsSettings = '/ebook';   // Medium-Low (Standard Web)
    else gsSettings = '/screen';                  // Low Quality (Max Compression)
  }

  // --- EXECUTE GHOSTSCRIPT ---
  
  // -dPDFSETTINGS presets:
  // /screen   (72 dpi, smallest)
  // /ebook    (150 dpi, medium)
  // /printer  (300 dpi, high)
  // /prepress (color preserving, largest)
  
  const gsCommand = `gs -dSAFER -dBATCH -dNOPAUSE -dNOCACHE -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${gsSettings} -sOutputFile="${outputPath}" "${inputPath}"`;

  console.log(`Compressing: Original ${originalSize.toFixed(2)}MB using settings ${gsSettings}`);

  exec(gsCommand, (error, stdout, stderr) => {
    if (error) {
      console.error(`exec error: ${error}`);
      return res.status(500).send('Compression failed.');
    }

    // Verify Result
    const newSize = getFileSizeMB(outputPath);
    console.log(`Finished: New Size ${newSize.toFixed(2)}MB`);

    // Add header so frontend knows the final size
    res.set('X-Original-Size', originalSize.toFixed(2));
    res.set('X-New-Size', newSize.toFixed(2));

    res.download(outputPath, 'compressed.pdf', (err) => {
      if (err) console.error(err);
      fs.unlinkSync(inputPath);
      fs.unlinkSync(outputPath);
    });
  });
});

app.post('/merge', upload.array('pdfFiles', 20), (req, res) => {
  if (!req.files || req.files.length < 2) {
    return res.status(400).send('Please upload at least 2 PDF files.');
  }

  // 1. Prepare Paths
  // Multer populates req.files (array), not req.file
  const inputPaths = req.files.map(f => f.path);
  const outputPath = `uploads/merged_${Date.now()}.pdf`;

  // 2. Build Ghostscript Command
  // Command: gs -dNOPAUSE -sDEVICE=pdfwrite -sOutputFile=out.pdf in1.pdf in2.pdf ...
  const inputFilesString = inputPaths.map(p => `"${p}"`).join(' ');
  const gsCommand = `gs -dBATCH -dNOPAUSE -q -sDEVICE=pdfwrite -sOutputFile="${outputPath}" ${inputFilesString}`;

  console.log(`Merging ${req.files.length} files...`);

  exec(gsCommand, (error, stdout, stderr) => {
    if (error) {
      console.error(`Merge error: ${error}`);
      return res.status(500).send('Merge failed.');
    }

    // 3. Send & Cleanup
    res.download(outputPath, 'merged-document.pdf', (err) => {
      if (err) console.error(err);
      
      // Delete output file
      fs.unlinkSync(outputPath);
      
      // Delete ALL input files
      inputPaths.forEach(path => {
        if (fs.existsSync(path)) fs.unlinkSync(path);
      });
    });
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
});
