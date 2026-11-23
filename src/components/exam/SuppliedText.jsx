// Display the supplied characters; never infer indentation or parse executable text.
export default function SuppliedText({ children, language }) {
  if (typeof children !== 'string') return children;
  // Display-only detection for single-line HTML/CSS alternatives. Never parse,
  // pretty-print, or insert whitespace into the supplied source.
  const htmlCss = language === 'html-css' && /<\/?[a-z][^>]*>|<!doctype|<!--|\{[^}]*\}|(?:^|;)\s*[\w-]+\s*:[^;]+;/i.test(children);
  if (!/[\n\r\t]/.test(children) && !htmlCss) return children;
  return <span className="supplied-multiline-text" tabIndex={0}>{children}</span>;
}
