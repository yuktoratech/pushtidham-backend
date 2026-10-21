const elements = new Set(["svg", "title", "desc", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop"]);
const attributes = new Set(["xmlns", "viewBox", "role", "aria-labelledby", "id", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "d", "points", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "transform"]);

/** Validate repository-owned SVG source for static use; this does not sanitize user uploads. */
export function validateTrustedSvg(source: string): {valid: boolean; reason?: string} {
  if (Buffer.byteLength(source, "utf8") > 256_000) return {valid: false, reason: "SVG exceeds the trusted asset size limit"};
  if (/<!DOCTYPE|<!ENTITY|<\?|<script\b|<foreignObject\b|\bon[a-z]+\s*=|\b(?:href|xlink:href|style)\s*=|url\((?!\s*#[A-Za-z_][\w.-]*\s*\))/i.test(source))
    return {valid: false, reason: "SVG contains active or external content"};
  const stack: string[] = [];
  const tokens = source.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? [];
  if (tokens.join("") !== source) return {valid: false, reason: "SVG markup is malformed"};
  let roots = 0;
  for (const token of tokens) {
    if (token.startsWith("<!--")) return {valid: false, reason: "SVG comments are not accepted"};
    if (!token.startsWith("<")) {
      if (stack.at(-1) !== "title" && stack.at(-1) !== "desc" && token.trim()) return {valid: false, reason: "Unexpected SVG text content"};
      if (/<[^&]*|&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(token)) return {valid: false, reason: "Invalid SVG text entity"};
      continue;
    }
    const closing = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>$/.exec(token);
    if (closing) {
      if (stack.pop() !== closing[1]) return {valid: false, reason: "SVG tags are unbalanced"};
      continue;
    }
    const opening = /^<([A-Za-z][A-Za-z0-9]*)([\s\S]*?)\s*(\/?)>$/.exec(token);
    if (!opening) return {valid: false, reason: "SVG element is malformed"};
    const name = opening[1] ?? "";
    if (!elements.has(name)) return {valid: false, reason: "SVG element is not allowlisted"};
    if (!stack.length) { if (name !== "svg" || ++roots > 1) return {valid: false, reason: "SVG must have one root element"}; }
    const rest = opening[2] ?? "";
    const attrPattern = /\s+([A-Za-z][A-Za-z0-9:-]*)\s*=\s*("[^"]*"|'[^']*')/gy;
    let offset = 0;
    while (offset < rest.length) {
      attrPattern.lastIndex = offset;
      const match = attrPattern.exec(rest);
      if (!match) { if (rest.slice(offset).trim()) return {valid: false, reason: "Malformed SVG attribute"}; break; }
      const key = match[1] ?? ""; const value = (match[2] ?? "").slice(1, -1);
      if (!attributes.has(key) || /[<>]/.test(value) || (/url\(/i.test(value) && !/^url\(#[A-Za-z_][\w.-]*\)$/.test(value)))
        return {valid: false, reason: "SVG attribute is not allowlisted"};
      offset = attrPattern.lastIndex;
    }
    if (opening[3] !== "/") stack.push(name);
  }
  return roots === 1 && stack.length === 0 ? {valid: true} : {valid: false, reason: "SVG is incomplete"};
}
