declare module "mammoth/mammoth.browser.js" {
  import mammoth = require("mammoth");
  export = mammoth;
}

declare module "pdfjs-dist/build/pdf.worker.min.mjs?url&no-inline" {
  const workerUrl: string;
  export default workerUrl;
}
