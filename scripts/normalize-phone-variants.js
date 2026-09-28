const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const inputPath = path.resolve(__dirname, '..', 'phone-variants.csv');

function parseSize(value) {
  const match = String(value).match(/^(\d+)(TB|GB)?$/i);
  if (!match) throw new Error(`Invalid memory size: ${value}`);

  const amount = Number(match[1]);
  const unit = (match[2] || 'GB').toUpperCase();
  return {
    gb: unit === 'TB' ? amount * 1024 : amount,
    label: unit === 'TB' ? `${amount}TB` : `${amount}GB`,
  };
}
function normalizeLabel(sourceLabel) {
  let match = sourceLabel.match(/^(\d+(?:TB|GB)?)\s*([+/])\s*(\d+(?:TB|GB)?)(?:\s+(.*))?$/i);
  if (match) {
    const first = parseSize(match[1]);
    const second = parseSize(match[3]);
    let ram;
    let storage;

    if (first.gb <= 16 && second.gb > 16) {
      ram = first.gb;
      storage = second;
    } else if (first.gb > 16 && second.gb <= 16) {
      storage = first;
      ram = second.gb;
    } else {
      throw new Error(`Cannot determine RAM/storage order for: ${sourceLabel}`);
    }

    const details = match[4] ? `, ${match[4].replace(/-/g, ' ')}` : '';
    return {
      label: `${ram}GB RAM, ${storage.label} storage${details}`,
      ramGb: ram,
      storageGb: storage.gb,
    };
  }

  match = sourceLabel.match(/^(\d+)(TB|GB)?(?:\s+(.*))?$/i);
  if (match) {
    const storage = parseSize(`${match[1]}${match[2] || 'GB'}`);
    const details = match[3] ? `, ${match[3].replace(/-/g, ' ')}` : '';
    return {
      label: `${storage.label} storage${details}`,
      ramGb: '',
      storageGb: storage.gb,
    };
  }

  throw new Error(`Cannot normalize source variant label: ${sourceLabel}`);
}

function escapeCsv(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function main() {
  const rows = parse(fs.readFileSync(inputPath), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  const headers = [
    'product_slug', 'variant_label', 'ram_gb', 'storage_gb', 'price_ksh', 'stock', 'market', 'warranty',
  ];
  const outputRows = rows.map((row) => {
    const alreadyStructured = Object.hasOwn(row, 'storage_gb') && row.storage_gb !== '';
    const formatted = alreadyStructured
      ? { label: row.variant_label, ramGb: row.ram_gb || '', storageGb: row.storage_gb }
      : normalizeLabel(row.source_variant_label || row.variant_label);
    const stock = row.stock === undefined || row.stock === '' ? 0 : Number(row.stock);
    if (!Number.isInteger(stock) || stock < 0) throw new Error(`Invalid stock for ${row.product_slug}`);

    return [
      row.product_slug,
      formatted.label,
      formatted.ramGb,
      formatted.storageGb,
      row.price_ksh,
      stock,
      row.market,
      row.warranty,
    ];
  });

  const contents = [headers, ...outputRows]
    .map((row) => row.map(escapeCsv).join(','))
    .join('\n') + '\n';
  fs.writeFileSync(inputPath, contents, 'utf8');
  console.log(`Normalized ${rows.length} variants; existing stock values were preserved.`);
}

try {
  main();
} catch (error) {
  console.error(`Variant normalization failed: ${error.message}`);
  process.exitCode = 1;
}