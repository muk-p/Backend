function normalizeMpesaPhone(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().replace(/[^0-9+]/g, '');
  if (!trimmed) {
    return null;
  }

  let normalized = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;

  if (normalized.startsWith('254')) {
    return normalized.length === 12 ? normalized : null;
  }

  if (normalized.startsWith('0')) {
    normalized = `254${normalized.slice(1)}`;
  } else {
    normalized = `254${normalized}`;
  }

  return normalized.length === 12 ? normalized : null;
}

module.exports = {
  normalizeMpesaPhone,
};
