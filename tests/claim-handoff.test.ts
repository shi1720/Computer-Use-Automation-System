import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EscalationBroker } from '@swivel/core';
const context = { runId: 'rep_claim_test', kind: 'replay' as const, url:'http://localhost/main', diagnosis:{code:'missing',message:'Missing target'} };
test('a live session stays claimable until an operator actually claims it', async () => {
 const broker = new EscalationBroker();
 const ticket = await broker.raise('target_unresolvable',context);
 let granted = false;
 const ready = broker.waitForClaim(ticket.id).then(i => { granted = true; return i; });
 await new Promise(r=>setTimeout(r,10));
 assert.equal(granted,false); assert.equal(ticket.status,'open');
 assert.throws(()=>broker.markInControl(ticket.id,{wsUrl:'ws://localhost',token:'test',viewport:{width:100,height:100}}),/claim/);
 broker.claim(ticket.id,{id:'person-1',name:'Operator'});
 const claimed = await ready; assert.equal(claimed.assignee?.id,'person-1');
 assert.equal(broker.listenerCount('updated'),0);
 broker.markInControl(ticket.id,{wsUrl:'ws://localhost',token:'test',viewport:{width:100,height:100}});
 assert.equal(ticket.status,'in_control');
});
test('an unclaimed session expires and releases the claim waiter', async () => {
 const broker = new EscalationBroker(undefined,15);
 const ticket = await broker.raise('target_unresolvable',context);
 const expired = await broker.waitForClaim(ticket.id);
 assert.equal(expired.status,'expired'); assert.equal(broker.listenerCount('updated'),0);
});
