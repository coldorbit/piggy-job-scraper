import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyJobAttributes,
  inferJobSeniority,
  inferJobWorkMode,
} from '../sites/lib/jobAttributes.js';

test('classifies source-provided seniority and work mode', () => {
  assert.deepEqual(classifyJobAttributes({
    title: 'Software Engineer',
    seniority: 'Senior Level',
    workplaceType: 'Fully Remote',
  }), { seniority: 'senior', workMode: 'remote' });
});

test('infers seniority with management precedence', () => {
  assert.equal(inferJobSeniority({ title: 'Senior Engineering Manager' }), 'manager');
  assert.equal(inferJobSeniority({ title: 'Principal ML Engineer' }), 'principal');
});

test('infers work mode conservatively', () => {
  assert.equal(inferJobWorkMode({ location: 'Hybrid - New York, NY' }), 'hybrid');
  assert.equal(inferJobWorkMode({ listingText: 'This is a fully remote position.' }), 'remote');
  assert.equal(inferJobWorkMode({ listingText: 'We offer flexible remote-work benefits.' }), 'unknown');
});

test('reads HiringCafe-style nested raw attributes', () => {
  assert.deepEqual(classifyJobAttributes({
    rawJob: { v5_processed_job_data: { seniority_level: 'Entry Level', workplace_type: 'Onsite' } },
  }), { seniority: 'entry_level', workMode: 'onsite' });
});
