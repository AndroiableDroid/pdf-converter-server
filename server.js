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

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
});
