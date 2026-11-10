import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { responseJson } from "../../lib/browser-api";
import { pdfEngine } from "../../lib/pdf-client";

export function PdfViewer({
  url,
  documentId,
  page,
  onPage,
}: {
  url: string;
  documentId: string;
  page: number;
  onPage: (page: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    area = useRef<HTMLDivElement>(null),
    rendering = useRef<any>(null);
  const [pdf, setPdf] = useState<any>(null),
    [count, setCount] = useState(0),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [zoom, setZoom] = useState(1),
    [width, setWidth] = useState(600),
    [textView, setTextView] = useState(false),
    [text, setText] = useState("");
  function cancel() {
    try {
      rendering.current?.cancel();
    } catch {
      /* A disposed task needs no further cancellation. */
    }
  }
  useEffect(() => {
    let active = true,
      task: any;
    setPdf(null);
    setCount(0);
    setError("");
    (async () => {
      const lib = await pdfEngine();
      if (!active) return;
      task = lib.getDocument({ url, isEvalSupported: false });
      const loaded = await task.promise;
      if (!active) return;
      setPdf(loaded);
      setCount(loaded.numPages);
    })().catch((e) => {
      if (active) setError(`PDF could not be loaded: ${e.message}`);
    });
    return () => {
      active = false;
      cancel();
      try {
        Promise.resolve(task?.destroy()).catch(() => {});
      } catch {
        /* Cleanup must never escape into React's unmount. */
      }
    };
  }, [url]);
  useEffect(() => {
    if (!area.current) return;
    const observer = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    observer.observe(area.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!pdf) return;
    let active = true,
      task: any;
    setLoading(true);
    setError("");
    (async () => {
      const n = Math.min(Math.max(1, Math.trunc(page) || 1), pdf.numPages);
      if (n !== page) onPage(n);
      const source = await pdf.getPage(n);
      if (!active) return;
      if (textView) {
        const content = await source.getTextContent();
        if (active)
          setText(
            content.items
              .filter((v: any) => "str" in v)
              .map((v: any) => v.str + (v.hasEOL ? "\n" : " "))
              .join(""),
          );
        return;
      }
      const base = source.getViewport({ scale: 1 }),
        viewport = source.getViewport({
          scale: (Math.max(240, width - 24) / base.width) * zoom,
        });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      // Render into a private canvas. Canceled/late PDF tasks can never reuse or
      // change the React canvas after a page change or dialog closure.
      const buffer = document.createElement("canvas");
      buffer.width = Math.ceil(viewport.width * ratio);
      buffer.height = Math.ceil(viewport.height * ratio);
      task = source.render({
        canvas: buffer,
        canvasContext: buffer.getContext("2d"),
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      rendering.current = task;
      await task.promise;
      const display = canvas.current;
      if (!active || !display) return;
      display.width = buffer.width;
      display.height = buffer.height;
      display.style.width = `${viewport.width}px`;
      display.style.height = `${viewport.height}px`;
      display.getContext("2d")!.drawImage(buffer, 0, 0);
    })()
      .catch((e) => {
        if (active && e.name !== "RenderingCancelledException")
          setError(`Page rendering failed: ${e.message}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      try {
        task?.cancel();
      } catch {
        /* Already disposed. */
      }
    };
  }, [pdf, page, width, zoom, textView, onPage]);
  useEffect(() => {
    if (!textView || pdf) return;
    const controller = new AbortController();
    setText("Loading stored page text…");
    fetch(`/api/documents?id=${encodeURIComponent(documentId)}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        const data = await responseJson(r);
        if (!controller.signal.aborted) {
          setCount(data.pages.length);
          setText(
            data.pages.find((p: any) => p.page === page)?.text ||
              "No selectable text is available on this page.",
          );
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setText(e.message);
      });
    return () => controller.abort();
  }, [textView, pdf, documentId, page]);
  return (
    <>
      <div className="pdf-toolbar">
        <div className="page-navigation">
          <button
            type="button"
            aria-label="Previous PDF page"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          >
            <ChevronLeft size={17} />
          </button>
          <label>
            <span className="sr-only">PDF page</span>
            <input
              aria-label="PDF page"
              type="number"
              min={1}
              max={count || undefined}
              step={1}
              value={page}
              onChange={(e) => {
                const n = e.currentTarget.valueAsNumber;
                if (Number.isInteger(n) && n >= 1 && (!count || n <= count))
                  onPage(n);
              }}
            />
            <span>/ {count || "…"}</span>
          </label>
          <button
            type="button"
            aria-label="Next PDF page"
            disabled={!count || page >= count}
            onClick={() => onPage(page + 1)}
          >
            <ChevronRight size={17} />
          </button>
        </div>
        <div className="actions">
          <button
            type="button"
            aria-label="Zoom out"
            disabled={zoom <= 0.5}
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))}
          >
            <ZoomOut size={16} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            aria-label="Zoom in"
            disabled={zoom >= 2}
            onClick={() => setZoom((z) => Math.min(2, z + 0.15))}
          >
            <ZoomIn size={16} />
          </button>
          <button
            type="button"
            className="source-link"
            onClick={() => setTextView((v) => !v)}
          >
            {textView ? "View PDF" : "Read page text"}
          </button>
        </div>
      </div>
      <div className="pdf-canvas-area" ref={area}>
        {error && (
          <p className="form-error" role="alert">
            {error} You can read the page text or open the original PDF.
          </p>
        )}
        {((!pdf && !error) || loading) && (
          <p role="status">
            <Loader2 className="spin" size={16} />{" "}
            {pdf ? "Rendering page…" : "Loading original PDF…"}
          </p>
        )}
        {textView ? (
          <pre className="pdf-text">
            {text || "No selectable text is available on this page."}
          </pre>
        ) : (
          <canvas
            ref={canvas}
            aria-label={`Source PDF page ${page}`}
            style={{ visibility: loading ? "hidden" : "visible" }}
          />
        )}
      </div>
      <div className="pdf-source-footer">
        <span>Original document · Physical PDF page {page}</span>
        <a href={`${url}#page=${page}`} target="_blank" rel="noreferrer">
          Open PDF <ExternalLink size={14} />
        </a>
      </div>
    </>
  );
}
