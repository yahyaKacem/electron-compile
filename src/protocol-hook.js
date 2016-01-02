import 'babel-polyfill';
import url from 'url';
import fs from 'fs';
import mime from 'mime-types';

import CompilerHost from './compiler-host';

const magicWords = "__magic__file__to__help__electron__compile.js";
const magicGlobalForRootCacheDir = '__electron_compile_root_cache_dir';

const d = require('debug')('electron-compile:protocol-hook');

let protocol = null;

export function rigHtmlDocumentToInitializeElectronCompile(doc) {
  let lines = doc.split("\n");
  let replacement = `<head><script src="${magicWords}"></script>`;
  let replacedHead = false;

  for (let i=0; i < lines.length; i++) {
    if (!lines[i].match(/<head>/i)) continue;

    lines[i] = (lines[i]).replace(/<head>/i, replacement);
    replacedHead = true;
    break;
  }

  if (!replacedHead) {
    replacement = `<html$1><head><script src="${magicWords}"></script></head>`;
    for (let i=0; i < lines.length; i++) {
      if (!lines[i].match(/<html/i)) continue;

      lines[i] = (lines[i]).replace(/<html([^>]+)>/i, replacement);
      break;
    }
  }

  return lines.join("\n");
}

function requestFileJob(filePath, finish) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { 
      if (err.errno === 34) {
        finish(-6); // net::ERR_FILE_NOT_FOUND
        return;
      } else {
        finish(-2); // net::FAILED
        return;
      }
    }
    
    finish({
      data: buf,
      mimeType: mime.lookup(filePath) || 'text/plain'
    });
  });
}

let rendererInitialized = false;
export function initializeRendererProcess(readOnlyMode) {
  if (rendererInitialized) return;
  
  // NB: If we don't do this, we'll get a renderer crash if you enable debug
  require('debug/browser');
  
  let rootCacheDir = require('remote').getGlobal(magicGlobalForRootCacheDir);
  let compilerHost = null;
  
  // NB: This has to be synchronous because we need to block HTML parsing
  // until we're set up
  if (readOnlyMode) {
    d(`Setting up electron-compile in precompiled mode with cache dir: ${rootCacheDir}`);
    compilerHost = CompilerHost.createReadonlyFromConfigurationSync(rootCacheDir);
  } else {
    d(`Setting up electron-compile in development mode with cache dir: ${rootCacheDir}`);
    const { createCompilers } = require('./config-parser');
    const compilersByMimeType = createCompilers();
    
    compilerHost = CompilerHost.createFromConfigurationSync(rootCacheDir, compilersByMimeType);
  }
  
  require('./x-require');
  require('./require-hook').default(compilerHost);
  rendererInitialized = true;
}

export function initializeProtocolHook(compilerHost) {
  protocol = protocol || require('protocol');
  
  global[magicGlobalForRootCacheDir] = compilerHost.rootCacheDir;
  
  const electronCompileSetupCode = `if (window.require) require('electron-compile/lib/protocol-hook').initializeRendererProcess(${compilerHost.readOnlyMode});`;

  protocol.interceptBufferProtocol('file', async function(request, finish) {
    let uri = url.parse(request.url);

    d(`Intercepting url ${request.url}`);
    if (request.url.indexOf(magicWords) > -1) {
      finish({
        mimeType: 'text/javascript',
        data: new Buffer(electronCompileSetupCode, 'utf8')
      });
      
      return;
    }

    // This is a protocol-relative URL that has gone pear-shaped in Electron,
    // let's rewrite it
    if (uri.host && uri.host.length > 1) {
      //let newUri = request.url.replace(/^file:/, "https:");
      // TODO: Jump off this bridge later
      d(`TODO: Found bogus protocol-relative URL, can't fix it up!!`);
      finish(-2);
    }

    let filePath = decodeURIComponent(uri.pathname);

    // NB: pathname has a leading '/' on Win32 for some reason
    if (process.platform === 'win32') {
      filePath = filePath.slice(1);
    }

    // NB: Special-case files coming from atom.asar or node_modules
    if (filePath.match(/[\/\\]atom.asar/) || filePath.match(/[\/\\]node_modules/)) {
      requestFileJob(filePath, finish);
      return;
    }
    
    try {
      let { code, mimeType } = await compilerHost.compile(filePath);
      
      if (filePath.match(/\.html?$/i)) {
        code = rigHtmlDocumentToInitializeElectronCompile(code);
      }
        
      finish({ data: new Buffer(code), mimeType });
      return;
    } catch (e) {
      let err = `Failed to compile ${filePath}: ${e.message}\n${e.stack}`;
      d(err);
      
      if (e.errno === 34 /*ENOENT*/) {
        finish(-6); // net::ERR_FILE_NOT_FOUND
        return;
      }

      finish({ mimeType: 'text/plain', data: new Buffer(err) });
      return;
    }
  });
}
