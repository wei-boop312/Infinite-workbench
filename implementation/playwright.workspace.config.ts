import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./tests/local-e2e',workers:1,reporter:'list',
  use:{headless:true,launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe'},trace:'retain-on-failure'},
});
