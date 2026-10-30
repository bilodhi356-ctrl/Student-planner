export function programCodeFromRegistrationNumber(registrationNumber) {
  const match = String(registrationNumber ?? '').trim().toUpperCase()
    .match(/^(CCT|CCS)\/\d{5}\/(?:19|20)\d{2}$/);
  if (!match) return null;
  return match[1] === 'CCT' ? 'BSC-CT' : 'BSC-CS';
}
