import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceRecorder, Redactor, verifyChain } from '@swivel/core';
test('concurrent recovery and operator events persist in hash-chain order and finish drains pending writes', async () => {
 const dir = await mkdtemp(join(tmpdir(),'swivel-chain-'));
 try {
  const recorder = new EvidenceRecorder(dir, {runId:'rep_concurrent',kind:'replay',startedAt:new Date().toISOString(),principal:{id:'test',kind:'system'},counts:{events:0,steps:0,screenshots:0,signals:0,recoveries:0,escalations:0},redaction:{},swivelVersion:'1.1.0'}, new Redactor({salt:'test'}));
  const writes = Array.from({length:200},(_,n)=>recorder.log('note',`event ${n}`));
  const manifest = await recorder.finish({status:'success'});
  await Promise.all(writes);
  assert.equal(manifest.counts.events,200);
  const events=(await readFile(join(dir,'events.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
  assert.deepEqual(events.map(e=>e.seq),Array.from({length:200},(_,i)=>i+1));
  assert.equal((await verifyChain(dir)).ok,true);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
