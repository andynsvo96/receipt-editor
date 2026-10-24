export {};

declare global {
  interface DesktopReceiptFile {
    name: string;
    source: string;
    size: number;
  }

  interface DesktopSaveRequest {
    defaultName: string;
    contents: string;
  }

  interface Window {
    receiptDesktop?: {
      platform: 'darwin' | 'win32' | 'linux';
      openFile: () => Promise<DesktopReceiptFile | null>;
      saveFile: (request: DesktopSaveRequest) => Promise<{ saved: boolean; path?: string }>;
      onOpenFile: (listener: (file: DesktopReceiptFile) => void) => () => void;
    };
  }
}
