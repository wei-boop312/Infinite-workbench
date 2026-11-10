import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests/owned-runtime-e2e',workers:1,timeout:90_000,reporter:'list',
  use:{headless:true,viewport:{width:1440,height:900},launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe'},trace:'retain-on-failure'}});
