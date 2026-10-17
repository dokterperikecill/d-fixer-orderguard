const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("node:path");

function getAppUrl() {
  const packagedConfigPath = path.join(app.getAppPath(), "package.json");
  const packagedUrl = app.isPackaged
    ? require(packagedConfigPath).orderGuardAppUrl || require(path.join(app.getAppPath(), "desktop.config.json")).appUrl
    : require("../desktop.config.json").appUrl;
  const configuredUrl = process.env.ORDERGUARD_APP_URL || packagedUrl;

  let url;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("URL aplikasi desktop tidak valid. Atur ORDERGUARD_APP_URL ke alamat HTTPS yang sudah di-deploy.");
  }
  if (url.protocol !== "https:" || !url.hostname || url.hostname.endsWith(".example")) {
    throw new Error("OrderGuard desktop memerlukan URL HTTPS produksi. Atur ORDERGUARD_APP_URL sebelum menjalankan atau membuat installer.");
  }
  return url;
}

async function openApp() {
  let appUrl;
  try {
    appUrl = getAppUrl();
  } catch (error) {
    console.error(error);
    dialog.showErrorBox("Konfigurasi OrderGuard belum siap", error.message);
    app.quit();
    return;
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#f5f5f0",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, destination) => {
    if (new URL(destination).origin !== appUrl.origin) event.preventDefault();
  });

  try {
    await window.loadURL(appUrl.toString());
  } catch (error) {
    console.error("Gagal membuka server OrderGuard.", error);
    dialog.showErrorBox("Server OrderGuard tidak dapat dibuka", `Periksa koneksi internet dan URL server.\n\n${error.message}`);
    window.close();
  }
}

app.whenReady().then(openApp);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
