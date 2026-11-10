let modulePromise: Promise<any> | undefined;
export async function pdfEngine() {
  if (!modulePromise) {
    const path = "/vendor/pdf.mjs";
    modulePromise = import(/* @vite-ignore */ path)
      .then((m) => {
        m.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.mjs";
        return m;
      })
      .catch((error) => {
        modulePromise = undefined;
        throw error;
      });
  }
  return modulePromise;
}
export async function readPdf(
  file: File,
  onProgress: (done: number, total: number) => void,
) {
  if (file.size >= 50000000)
    throw new Error("Choose a PDF smaller than 50 MB.");
  const lib = await pdfEngine();
  const task = lib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
  });
  const pages = [];
  try {
    const doc = await task.promise;
    if (doc.numPages > 1000)
      throw new Error("Please split PDFs with more than 1,000 pages.");
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i),
        content = await page.getTextContent();
      let text = "";
      for (const item of content.items)
        if ("str" in item) text += item.str + (item.hasEOL ? "\n" : " ");
      pages.push({ page: i, text });
      onProgress(i, doc.numPages);
      page.cleanup();
    }
  } finally {
    // Preserve the original load/read error and never leave an import worker alive.
    try {
      await task.destroy();
    } catch {
      /* Worker may already have terminated. */
    }
  }
  return pages;
}
