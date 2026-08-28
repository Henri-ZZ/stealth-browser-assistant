#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const LISTING_DIR = path.join(ROOT, 'store-listing');
const DESCRIPTION_DIR = path.join(LISTING_DIR, 'descriptions');
const OUTPUT_DIR = path.join(LISTING_DIR, 'generated');
const localeMap = JSON.parse(fs.readFileSync(path.join(LISTING_DIR, 'locales.json'), 'utf8'));
const firefoxConfig = JSON.parse(fs.readFileSync(path.join(LISTING_DIR, 'firefox.json'), 'utf8'));
const locales = Object.keys(localeMap);

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

function readLocale(locale) {
  const messagesPath = path.join(ROOT, '_locales', locale, 'messages.json');
  const descriptionPath = path.join(DESCRIPTION_DIR, `${locale}.txt`);
  if (!fs.existsSync(messagesPath)) throw new Error(`missing ${messagesPath}`);
  if (!fs.existsSync(descriptionPath)) throw new Error(`missing ${descriptionPath}`);
  const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
  return {
    locale,
    title: messages.extName?.message?.trim() || '',
    summary: messages.extDescription?.message?.trim() || '',
    description: fs.readFileSync(descriptionPath, 'utf8').trim(),
  };
}

function validate(listings) {
  const errors = [];
  const expectedTitle = 'Stealth Browser Assistant — Hide Tabs & Panic Button';
  for (const item of listings) {
    if (item.title !== expectedTitle) errors.push(`${item.locale}: unexpected Title`);
    if ([...item.summary].length > 132) {
      errors.push(`${item.locale}: Summary exceeds 132 characters`);
    }
    if (!item.summary) errors.push(`${item.locale}: Summary is empty`);
    if (!item.description) errors.push(`${item.locale}: Detailed Description is empty`);
    if ([...item.description].length > 10000) {
      errors.push(`${item.locale}: Detailed Description exceeds 10,000 characters`);
    }
  }

  if (!firefoxConfig.title) errors.push('Firefox: Title is empty');
  if ([...firefoxConfig.title].length > 50) {
    errors.push('Firefox: Title exceeds 50 characters');
  }

  const english = listings.find((item) => item.locale === 'en');
  for (const term of [
    'Panic Button', 'private', 'Keywords', 'Mute', 'Hide',
    'Close matching tabs', 'Match hit feedback', 'Clean private data',
    'Auto cleanup', 'License Key', 'Premium',
  ]) {
    if (!english.description.includes(term)) errors.push(`en: missing canonical term "${term}"`);
  }
  if (/Emergency Action|Emergency Mode/.test(english.description)) {
    errors.push('en: obsolete Emergency terminology found');
  }
  return errors;
}

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${content.trim()}\n`);
}

function exportListings(listings) {
  for (const item of listings) {
    const combined = [
      'TITLE', item.title, '',
      'SUMMARY FROM PACKAGE', item.summary, '',
      'DETAILED DESCRIPTION', item.description,
    ].join('\n');
    writeText(path.join(OUTPUT_DIR, 'chrome', `${item.locale}.txt`), combined);
    writeText(path.join(OUTPUT_DIR, 'edge', `${localeMap[item.locale].edge}.txt`), combined);
  }

  const firefoxPayload = {
    name: Object.fromEntries(listings.map((item) => [localeMap[item.locale].firefox, firefoxConfig.title])),
    summary: Object.fromEntries(listings.map((item) => [localeMap[item.locale].firefox, item.summary])),
    description: Object.fromEntries(listings.map((item) => [localeMap[item.locale].firefox, item.description])),
  };
  writeText(
    path.join(OUTPUT_DIR, 'firefox', 'listing-payload.json'),
    JSON.stringify(firefoxPayload, null, 2),
  );

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: {
      titleAndSummary: '_locales/<locale>/messages.json',
      firefoxTitle: 'store-listing/firefox.json',
      detailedDescription: 'store-listing/descriptions/<locale>.txt',
    },
    locales: listings.map((item) => ({
      source: item.locale,
      edge: localeMap[item.locale].edge,
      firefox: localeMap[item.locale].firefox,
    })),
  };
  writeText(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

let listings;
try {
  listings = locales.map(readLocale);
} catch (error) {
  fail(error.message);
  process.exit();
}

const errors = validate(listings);
if (errors.length) {
  errors.forEach(fail);
  process.exit();
}

const command = process.argv[2] || 'check';
if (command === 'check') {
  for (const item of listings) {
    console.log(`${item.locale}: Title ${[...item.title].length}, Summary ${[...item.summary].length}/132, Description ${[...item.description].length}`);
  }
  console.log('Store listing validation passed.');
} else if (command === 'export') {
  exportListings(listings);
  console.log(`Generated Chrome, Edge, and Firefox listing files in ${OUTPUT_DIR}`);
} else if (command === 'show') {
  const locale = process.argv[3] || 'en';
  const item = listings.find((entry) => entry.locale === locale);
  if (!item) fail(`unknown locale "${locale}"`);
  else console.log(`${item.title}\n\n${item.summary}\n\n${item.description}`);
} else {
  fail('usage: ./store-listing.sh [check | export | show <locale>]');
}
