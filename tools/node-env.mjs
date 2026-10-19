// Minimal browser shims so three.js GLTFExporter/GLTFLoader run under node (tests and tools).
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class FileReader {
    constructor() {
      this.result = null;
      this.onloadend = null;
      this.onload = null;
    }
    _done(result) {
      this.result = result;
      const ev = { target: this };
      if (this.onload) this.onload(ev);
      if (this.onloadend) this.onloadend(ev);
    }
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((b) => this._done(b));
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((b) => this._done(`data:${blob.type || 'application/octet-stream'};base64,` + Buffer.from(b).toString('base64')));
    }
  };
}
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
