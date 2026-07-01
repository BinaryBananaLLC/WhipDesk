// Asset imports resolve to a URL string (Vite emits a hashed, base-correct path so the same
// build works at "/" on the LAN and under "/app/" on whipdesk.com).
declare module "*.png" {
  const url: string;
  export default url;
}
