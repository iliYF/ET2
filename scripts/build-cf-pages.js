#!/usr/bin/env node
/**
 * Build script for cf-pages branch deployment.
 *
 * Performs 3 textual operations on _worker.js (source stays untouched):
 *   1.  Add "&& 伪装页URL !== 'custom'" to the URL exclusion check
 *   2.  Insert custom route handler after the 1101 handler
 *   3.  Append htmlCustom() function at end of file
 *
 * Configuration via environment variables:
 *   CUSTOM_PAGE_FILE  path to static HTML page (default: pages/custom.html)
 *                     only changes the page content; key and function name are fixed
 */

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 1.  Resolve configuration
// ---------------------------------------------------------------------------

var pageFile = process.env.CUSTOM_PAGE_FILE || 'pages/custom.html';
var pagePath = path.join(ROOT, pageFile);

console.log('CUSTOM_PAGE_FILE = ' + pageFile);

// ---------------------------------------------------------------------------
// 2.  Read source files
// ---------------------------------------------------------------------------

if (!fs.existsSync(pagePath)) {
    console.error('ERROR: CUSTOM_PAGE_FILE not found: ' + pagePath);
    process.exit(1);
}

var pageHtml = fs.readFileSync(pagePath, 'utf8');
var workerContent = fs.readFileSync(path.join(ROOT, '_worker.js'), 'utf8');

// ---------------------------------------------------------------------------
// 3.  Minify CSS and HTML
// ---------------------------------------------------------------------------

var STYLE_OPEN = '<style>';
var STYLE_CLOSE = '</style>';
var styleStart = pageHtml.indexOf(STYLE_OPEN);
var styleEnd = pageHtml.indexOf(STYLE_CLOSE);

function minifyCss(css) {
    return css
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .replace(/\s*{\s*/g, '{')
        .replace(/\s*}\s*/g, '}')
        .replace(/\s*;\s*/g, ';')
        .replace(/\s*:\s*/g, ':')
        .replace(/\s*,\s*/g, ',')
        .replace(/;}/g, '}')
        .trim();
}

function minifyHtml(html) {
    return html
        .split('\n')
        .map(function (line) { return line.trim(); })
        .filter(function (line) { return line.length > 0; })
        .join('\n');
}

var minifiedPage;
if (styleStart !== -1 && styleEnd !== -1) {
    var beforeStyle = pageHtml.substring(0, styleStart);
    var rawCss = pageHtml.substring(styleStart + STYLE_OPEN.length, styleEnd);
    var afterStyle = pageHtml.substring(styleEnd + STYLE_CLOSE.length);
    minifiedPage = (
        minifyHtml(beforeStyle)
        + STYLE_OPEN + minifyCss(rawCss) + STYLE_CLOSE
        + minifyHtml(afterStyle)
    );
} else {
    minifiedPage = minifyHtml(pageHtml);
}

var indentedPage = minifiedPage
    .split('\n')
    .map(function (line) {
        return '\t' + line.replace(/`/g, '\\`');
    })
    .join('\n');

// ---------------------------------------------------------------------------
// 4.  Textual replacement 1: add "et" to URL exclusion check
// ---------------------------------------------------------------------------

var exclusionOld = (
    "if (伪装页URL && 伪装页URL !== 'nginx' && 伪装页URL !== '1101') {"
);
var exclusionNew = (
    "if (伪装页URL && 伪装页URL !== 'nginx'"
    + " && 伪装页URL !== '1101' && 伪装页URL !== 'custom') {"
);

if (workerContent.includes(exclusionOld)) {
    workerContent = workerContent.replace(exclusionOld, exclusionNew);
} else if (!workerContent.includes("伪装页URL !== 'custom'")) {
    console.error('ERROR: Could not find URL exclusion line to patch.');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 5.  Textual replacement 2: insert route handler after 1101 handler
// ---------------------------------------------------------------------------

var handler1101 = (
    "\t\tif (伪装页URL === '1101') "
    + "return new Response(await html1101(url.host, 访问IP), "
    + "{ status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });"
);

var customHandlerLine = (
    "\t\tif (伪装页URL === 'custom') "
    + "return new Response(await htmlCustom(), "
    + "{ status: 200, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });"
);

if (workerContent.includes(handler1101)) {
    workerContent = workerContent.replace(
        handler1101 + '\n',
        handler1101 + '\n' + customHandlerLine + '\n',
    );
} else {
    console.error('ERROR: Could not find 1101 handler line to insert after.');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 6.  Textual replacement 3: append htmlCustom() function at end of file
// ---------------------------------------------------------------------------

var htmlCustomFunc = '\n\n';
htmlCustomFunc += 'async function htmlCustom() {\n';
htmlCustomFunc += '\treturn `' + indentedPage + '`;\n';
htmlCustomFunc += '}\n';

workerContent += htmlCustomFunc;

// ---------------------------------------------------------------------------
// 7.  Write output to dist/
// ---------------------------------------------------------------------------

var distDir = path.join(ROOT, 'dist');
if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true });
}
fs.mkdirSync(distDir, { recursive: true });

fs.writeFileSync(path.join(distDir, '_worker.js'), workerContent);
fs.copyFileSync(
    path.join(ROOT, 'wrangler.toml'),
    path.join(distDir, 'wrangler.toml'),
);

// ---------------------------------------------------------------------------
// 8.  Report
// ---------------------------------------------------------------------------

console.log('Build complete → dist/_worker.js  dist/wrangler.toml');
console.log("  1. URL exclusion → + && 伪装页URL !== 'custom'");
console.log('  2. Route handler → custom → htmlCustom()');
console.log('  3. htmlCustom()      → ' + pageFile);
