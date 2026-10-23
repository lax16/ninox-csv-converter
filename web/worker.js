// Converts a Ninox backup (.ninox, a ZIP file) to one CSV per table, entirely in the browser.
// Everything is streamed: the backup is read in slices, data.db is decompressed and parsed line by line,
// and CSV rows are written out as soon as they are produced, so memory use does not grow with the file size.

importScripts('vendor/zip-core.min.js');
zip.configure({ useWebWorkers: false });

// data.db lines look like "{key}:{json}". The Python version used [a-zA-Z1-9], which silently skipped every key containing a 0.
const KEY_RE = /^[A-Za-z0-9]+$/;
// records are stored as "U{table_id}{record_id}", e.g. "UA11" is record 11 of table "A"
const RECORD_KEY_RE = /^U([A-Z]+)([0-9]+)$/;
const FLUSH_CHARS = 256 * 1024;
const PROGRESS_INTERVAL_MS = 200;
const OPFS_WORK_DIR = 'ninox-csv';

const encoder = new TextEncoder();

self.onmessage = async (event) => {
  try {
    await convert(event.data);
  } catch (err) {
    post({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

function post(message) {
  self.postMessage(message);
}

async function convert({ file, mode, dirHandle, bom }) {
  const startedAt = Date.now();
  const reader = new zip.ZipReader(new zip.BlobReader(file));
  const entries = await reader.getEntries();
  const dataEntry = entries.find((e) => e.filename === 'data.db') || entries.find((e) => e.filename.endsWith('/data.db'));
  if (!dataEntry) {
    throw new Error('No data.db found in this file. Is it a Ninox backup?');
  }

  const output = mode === 'folder' ? createFolderOutput(dirHandle) : await createZipOutput(file.name);
  const converter = new Converter(output, bom);

  let lastProgress = 0;
  const reportProgress = (force) => {
    const now = Date.now();
    if (!force && now - lastProgress < PROGRESS_INTERVAL_MS) return;
    lastProgress = now;
    post({
      type: 'progress',
      phase: 'convert',
      done: converter.bytesIn,
      total: dataEntry.uncompressedSize,
      records: converter.stats.records,
      tables: converter.tables.size,
    });
  };

  const { readable, writable } = new TransformStream({
    transform(chunk, controller) {
      converter.bytesIn += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const extraction = dataEntry.getData(writable);
  const lines = readable.pipeThrough(new TextDecoderStream('utf-8')).getReader();

  // split the decoded text into lines; an unfinished line is kept as a list of pieces so very long lines are joined only once
  let pending = [];
  for (;;) {
    const { value, done } = await lines.read();
    if (done) break;
    let start = 0;
    let newline;
    while ((newline = value.indexOf('\n', start)) !== -1) {
      let line = value.slice(start, newline);
      if (pending.length) {
        pending.push(line);
        line = pending.join('');
        pending = [];
      }
      converter.handleLine(line);
      start = newline + 1;
    }
    if (start < value.length) pending.push(value.slice(start));
    await converter.flushFull();
    reportProgress(false);
  }
  if (pending.length) converter.handleLine(pending.join(''));
  await extraction;
  await reader.close();
  reportProgress(true);

  if (!converter.schema) {
    throw new Error('No table definitions found in data.db.');
  }
  await converter.closeAll();

  const result = await output.finish((done, total) => post({ type: 'progress', phase: 'zip', done, total }));
  post({
    type: 'done',
    result,
    stats: converter.stats,
    tables: [...converter.tables.values()].map((t) => ({ caption: t.caption, file: t.fileName, rows: t.rows })),
    seconds: (Date.now() - startedAt) / 1000,
  });
}

class Converter {
  constructor(output, bom) {
    this.output = output;
    this.bom = bom;
    this.schema = null;
    this.tables = new Map(); // table id -> table state, created when the table's first record shows up
    this.usedFileNames = new Set();
    this.creating = []; // sinks are created asynchronously, rows are buffered until flushFull() awaits them
    this.bytesIn = 0;
    this.stats = { records: 0, unknownTable: 0, invalidLines: 0 };
  }

  handleLine(line) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const sep = line.indexOf(':');
    if (sep < 1 || line.charCodeAt(sep + 1) !== 123 /* { */) return;
    const key = line.slice(0, sep);
    if (!KEY_RE.test(key)) return;

    let data;
    try {
      data = JSON.parse(line.slice(sep + 1));
    } catch {
      this.stats.invalidLines++;
      return;
    }

    // the first entry ("s") holds the database schema with all tables and fields
    if (!this.schema && data.types) {
      this.schema = data.types;
      return;
    }

    const match = RECORD_KEY_RE.exec(key);
    if (!match || typeof data !== 'object' || data === null) return;
    if (!this.schema) {
      throw new Error('Found records before the table definitions in data.db.');
    }
    const [, tableId, recordId] = match;
    const tableDef = this.schema[tableId];
    if (!tableDef) {
      this.stats.unknownTable++;
      return;
    }

    const table = this.tables.get(tableId) || this.openTable(tableId, tableDef);
    table.push(recordRow(table.fields, recordId, data));
    table.rows++;
    this.stats.records++;
  }

  openTable(tableId, tableDef) {
    const fields = Object.entries(tableDef.fields || {});
    const fileName = uniqueFileName(tableDef.caption || tableId, this.usedFileNames);
    const table = new TableWriter(tableDef.caption || tableId, fileName, fields);
    this.creating.push(this.output.createSink(fileName).then((sink) => { table.sink = sink; }));
    table.push((this.bom ? '﻿' : '') + headerRow(fields));
    this.tables.set(tableId, table);
    return table;
  }

  async flushFull() {
    if (this.creating.length) {
      await Promise.all(this.creating);
      this.creating = [];
    }
    for (const table of this.tables.values()) {
      if (table.size >= FLUSH_CHARS) await table.flush();
    }
  }

  async closeAll() {
    await this.flushFull();
    for (const table of this.tables.values()) await table.close();
  }
}

class TableWriter {
  constructor(caption, fileName, fields) {
    this.caption = caption;
    this.fileName = fileName;
    this.fields = fields;
    this.sink = null;
    this.parts = [];
    this.size = 0;
    this.rows = 0;
  }

  push(text) {
    this.parts.push(text);
    this.size += text.length;
  }

  async flush() {
    if (!this.size) return;
    const bytes = encoder.encode(this.parts.join(''));
    this.parts = [];
    this.size = 0;
    await this.sink.write(bytes);
  }

  async close() {
    await this.flush();
    await this.sink.close();
  }
}

function headerRow(fields) {
  const columns = ['ID', 'Erstellungsdatum', 'Änderungsdatum'];
  for (const [, field] of fields) {
    // reference fields hold the ID of the referenced record, marked with "-ref"
    columns.push(field.base === 'ref' ? `${field.caption}-ref` : field.caption);
  }
  return columns.map(csvField).join(';') + '\r\n';
}

function recordRow(fields, recordId, record) {
  const columns = [recordId, record._cd ?? '', record._md ?? ''];
  for (const [fieldId, field] of fields) {
    columns.push(formatValue(field, record[fieldId]));
  }
  return columns.map(csvField).join(';') + '\r\n';
}

function formatValue(field, value) {
  if (value === undefined || value === null) return '';
  // choice fields store the id of the selected option, use its caption instead
  if (field.base === 'choice' && field.values && Object.hasOwn(field.values, value)) {
    return field.values[value].caption ?? value;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

// RFC 4180 quoting: values containing the separator, quotes or line breaks are wrapped in quotes, inner quotes are doubled
function csvField(value) {
  const text = String(value);
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function uniqueFileName(caption, used) {
  const base = String(caption).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim() || 'Tabelle';
  let name = `${base}.csv`;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).csv`;
  used.add(name.toLowerCase());
  return name;
}

// Output: write each CSV directly into a folder the user picked (File System Access API, Chromium only)
function createFolderOutput(dirHandle) {
  return {
    async createSink(fileName) {
      const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      return { write: (bytes) => writable.write(bytes), close: () => writable.close() };
    },
    async finish() {
      return { type: 'folder', folder: dirHandle.name };
    },
  };
}

// Output: write the CSVs to the origin private file system (OPFS, on disk), then pack them into one ZIP there.
// The page downloads that ZIP as a disk-backed File, so nothing large is held in memory.
async function createZipOutput(backupName) {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(OPFS_WORK_DIR, { recursive: true }).catch(() => {});
  const workDir = await root.getDirectoryHandle(OPFS_WORK_DIR, { create: true });
  const tmpDir = await workDir.getDirectoryHandle('tmp', { create: true });
  const fileNames = [];

  return {
    async createSink(fileName) {
      fileNames.push(fileName);
      const fileHandle = await tmpDir.getFileHandle(fileName, { create: true });
      return syncHandleSink(await fileHandle.createSyncAccessHandle());
    },

    async finish(onProgress) {
      const files = [];
      for (const name of fileNames) files.push(await (await tmpDir.getFileHandle(name)).getFile());
      const total = files.reduce((sum, f) => sum + f.size, 0);

      const zipName = backupName.replace(/\.[^.]*$/, '') + '-csv.zip';
      const zipHandle = await workDir.getFileHandle(zipName, { create: true });
      const sink = syncHandleSink(await zipHandle.createSyncAccessHandle());
      const zipWriter = new zip.ZipWriter(
        new WritableStream({ write: (chunk) => sink.write(chunk), close: () => sink.close() }),
        { zip64: total > 0xf0000000 }
      );
      let packed = 0;
      for (const file of files) {
        await zipWriter.add(file.name, new zip.BlobReader(file), {
          onprogress: (done) => onProgress(packed + done, total),
        });
        packed += file.size;
      }
      await zipWriter.close();
      sink.close();
      await workDir.removeEntry('tmp', { recursive: true });
      return { type: 'zip', opfsDir: OPFS_WORK_DIR, fileName: zipName };
    },
  };
}

function syncHandleSink(handle) {
  let position = 0;
  let closed = false;
  handle.truncate(0);
  return {
    write(bytes) {
      position += handle.write(bytes, { at: position });
    },
    close() {
      if (closed) return;
      closed = true;
      handle.flush();
      handle.close();
    },
  };
}
