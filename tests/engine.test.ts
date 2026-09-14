import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collect,dispatch,type State,type Job} from '../src/engine.js';
import {parseConfig} from '../src/core.js';
const uid='11111111-1111-4111-8111-111111111111';
const cfg=()=>parseConfig({AZURE_TENANT_ID:uid,USER_CHANNELS:'teams',PILOT_USER_IDS:uid,COLLECTION_ENABLED:'true'});
class Memory implements State {
  cp:{start:string;cursor:string}|undefined; jobs=new Map<string,Job>();
  async checkpoint(){return this.cp;} async saveCheckpoint(v:{start:string;cursor:string}){this.cp=v;}
  async add(job:Job){if(!this.jobs.has(job.key))this.jobs.set(job.key,{...job});}
  async *pending(){for(const job of this.jobs.values())if(job.status==='pending')yield job;}
  async claim(job:Job){if(job.status!=='pending')return false;job.status='sending';return true;}
  async finish(job:Job,status:string){job.status=status;}
}
const event={id:'audit-1',activityDisplayName:'Add Passkey (device-bound)',result:'success',activityDateTime:'2026-09-13T01:01:00Z',targetResources:[{id:uid,type:'User'}]};
const reader={async *audits(){yield [event];}};
test('first activation establishes boundary without reading historical logs',async()=>{const s=new Memory();let read=false;await collect(cfg(),s,{async *audits(){read=true;yield [];}},new Date('2026-09-13T01:00:00Z'));assert.equal(read,false);assert.equal(s.cp?.start,'2026-09-13T01:00:00.000Z');});
test('overlap and restart preserve deduplication, provider acceptance stops repeat sends',async()=>{const s=new Memory();s.cp={start:'2026-09-13T01:00:00.000Z',cursor:'2026-09-13T01:00:00.000Z'};await collect(cfg(),s,reader,new Date('2026-09-13T01:02:00Z'));await collect(cfg(),s,reader,new Date('2026-09-13T01:03:00Z'));assert.equal(s.jobs.size,1);let sent=0;await dispatch(cfg(),s,async()=>{sent++;});await dispatch(cfg(),s,async()=>{sent++;});assert.equal(sent,1);});
test('incomplete page traversal does not advance checkpoint and replay is safe',async()=>{const s=new Memory();s.cp={start:'2026-09-13T01:00:00.000Z',cursor:'2026-09-13T01:00:00.000Z'};await assert.rejects(collect(cfg(),s,{async *audits(){yield [event];throw Error('ReadFailure');}},new Date('2026-09-13T01:02:00Z')));assert.equal(s.cp.cursor,s.cp.start);await collect(cfg(),s,reader,new Date('2026-09-13T01:02:00Z'));assert.equal(s.jobs.size,1);});
test('ambiguous send is retained for review, never automatically resent',async()=>{const s=new Memory();s.cp={start:'2026-09-13T01:00:00.000Z',cursor:'2026-09-13T01:00:00.000Z'};await collect(cfg(),s,reader,new Date('2026-09-13T01:02:00Z'));let attempts=0;await dispatch(cfg(),s,async()=>{attempts++;throw Error('Timeout');});await dispatch(cfg(),s,async()=>{attempts++;});assert.equal(attempts,1);assert.equal([...s.jobs.values()][0].status,'review');});
test('ineligible queued work is suppressed and is not sent after a pilot is restored',async()=>{const s=new Memory();s.cp={start:'2026-09-13T01:00:00.000Z',cursor:'2026-09-13T01:00:00.000Z'};await collect(cfg(),s,reader,new Date('2026-09-13T01:02:00Z'));const removed=parseConfig({AZURE_TENANT_ID:uid,USER_CHANNELS:'teams',PILOT_USER_IDS:'22222222-2222-4222-8222-222222222222',COLLECTION_ENABLED:'true'});let sent=0;await dispatch(removed,s,async()=>{sent++;});assert.equal(sent,0);assert.equal([...s.jobs.values()][0].status,'suppressed');await dispatch(cfg(),s,async()=>{sent++;});assert.equal(sent,0);});
test('disabled collection does not read or send',async()=>{const s=new Memory();const config={...cfg(),enabled:false};assert.equal(await collect(config,s,reader),0);assert.equal(await dispatch(config,s,async()=>{throw Error('Unexpected');}),0);assert.equal(s.cp,undefined);});
