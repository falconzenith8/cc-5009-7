// Shared Playwright launcher. On this Linux image the bundled headless shell
// needs a few system libraries that are not installed; tools/linux-libs.sh
// fetches them into .cache/linux-libs. If that directory exists we prepend it
// to LD_LIBRARY_PATH. Nothing is downloaded at test time.
import fs from "node:fs";
import { chromium } from "playwright";

const LIBS_DIR = new URL("../../.cache/linux-libs", import.meta.url).pathname;
if (fs.existsSync(LIBS_DIR)) {
  const paths = [
    `${LIBS_DIR}/usr/lib/aarch64-linux-gnu`,
    `${LIBS_DIR}/lib/aarch64-linux-gnu`,
    `${LIBS_DIR}/usr/lib/x86_64-linux-gnu`,
  ].filter((p) => fs.existsSync(p));
  process.env.LD_LIBRARY_PATH = [...paths, process.env.LD_LIBRARY_PATH || ""].join(":");
}

export async function launchBrowser(options = {}) {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    ...options,
  });
}
