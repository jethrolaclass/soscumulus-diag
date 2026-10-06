// HTML files are bundled as text (see the Text rule in wrangler.toml).
declare module '*.html' {
  const content: string;
  export default content;
}
