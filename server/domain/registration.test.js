import assert from 'node:assert/strict';
import test from 'node:test';
import { programCodeFromRegistrationNumber } from './registration.js';

test('infers a student program from the registration number prefix', () => {
  assert.equal(programCodeFromRegistrationNumber('CCS/00012/2024'), 'BSC-CS');
  assert.equal(programCodeFromRegistrationNumber('cct/00002/2023'), 'BSC-CT');
});

test('does not infer a program from an invalid registration number', () => {
  assert.equal(programCodeFromRegistrationNumber('CCS/12/2024'), null);
  assert.equal(programCodeFromRegistrationNumber('ABC/00012/2024'), null);
});
