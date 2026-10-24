const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const RECEIPT_EXTENSION = /\.(html?|mhtml|mht)$/i;
const isDevelopment = Boolean(process.env.ELECTRON_RENDERER_URL);
let mainWindow = null;
let pendingFilePath = null;

function isReceiptPath(filePath) {
  return typeof filePath === 'string' && RECEIPT_EXTENSION.test(filePath);
}

async function readReceipt(filePath) {
  if (!isReceiptPath(filePath)) throw new Error('Choose an HTML, HTM, MHTML, or MHT receipt file.');
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error('The selected receipt is not a file.');
  if (stats.size > MAX_FILE_BYTES) throw new Error('This file is larger than 20 MB. Choose a smaller receipt file.');
  return {
    name: path.basename(filePath),
    source: await fs.readFile(filePath, 'utf8'),
    size: stats.size,
  };
}

async function sendReceiptToWindow(filePath) {
  try {
    const receipt = await readReceipt(filePath);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('receipt:file-opened', receipt);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      pendingFilePath = filePath;
    }
  } catch (error) {
    dialog.showErrorBox('Could not open receipt', error instanceof Error ? error.message : 'The receipt could not be opened.');
  }
}

async function chooseReceipt() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open receipt',
    properties: ['openFile'],
    filters: [
      { name: 'Receipt files', extensions: ['html', 'htm', 'mhtml', 'mht'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return readReceipt(result.filePaths[0]);
}

function installMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Receipt…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const receipt = await chooseReceipt();
            if (receipt && mainWindow) mainWindow.webContents.send('receipt:file-opened', receipt);
          },
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }])] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#f7f8fa',
    show: false,
    title: 'Receipt Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  if (isDevelopment) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else mainWindow.loadFile(path.join(__dirname, '..', 'desktop-dist', 'index.html'));

  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingFilePath) {
      const filePath = pendingFilePath;
      pendingFilePath = null;
      sendReceiptToWindow(filePath);
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const filePath = argv.find(isReceiptPath);
    if (filePath) sendReceiptToWindow(filePath);
    else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (app.isReady()) sendReceiptToWindow(filePath);
    else pendingFilePath = filePath;
  });

  app.whenReady().then(() => {
    ipcMain.handle('receipt:open', chooseReceipt);
    ipcMain.handle('receipt:save', async (_event, request) => {
      if (!request || typeof request.defaultName !== 'string' || typeof request.contents !== 'string') {
        throw new Error('The save request was not valid.');
      }
      if (Buffer.byteLength(request.contents, 'utf8') > MAX_FILE_BYTES * 2) {
        throw new Error('The exported receipt is unexpectedly large and was not saved.');
      }
      const safeName = path.basename(request.defaultName).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save receipt',
        defaultPath: safeName,
        filters: isReceiptPath(safeName)
          ? [{ name: 'Receipt file', extensions: [path.extname(safeName).slice(1)] }]
          : [{ name: 'JSON file', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { saved: false };
      await fs.writeFile(result.filePath, request.contents, 'utf8');
      return { saved: true, path: result.filePath };
    });

    installMenu();
    createWindow();
    const startupFile = process.argv.find((value, index) => index > 0 && isReceiptPath(value));
    if (startupFile) pendingFilePath = startupFile;

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
