declare module "screenshot-desktop" {
  interface ScreenshotOptions {
    format?: "png" | "jpg";
    /** Display id from listDisplays(), or index. */
    screen?: string | number;
    filename?: string;
  }
  interface Display {
    id: string | number;
    name: string;
    [key: string]: unknown;
  }
  function screenshot(options?: ScreenshotOptions): Promise<Buffer>;
  namespace screenshot {
    function listDisplays(): Promise<Display[]>;
    function all(options?: ScreenshotOptions): Promise<Buffer[]>;
  }
  export = screenshot;
}
