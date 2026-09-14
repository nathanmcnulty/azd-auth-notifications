import { DefaultAzureCredential } from '@azure/identity';
export interface GraphCredential { getToken(scope:string):Promise<{token:string}|null>; }
export type GraphFetch = typeof fetch;
function tokenTenant(token:string):string|undefined {
  const parts=token.split('.');
  if (parts.length!==3) return undefined;
  try {
    const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8')) as {tid?:unknown};
    return typeof payload.tid==='string'?payload.tid.toLowerCase():undefined;
  } catch { return undefined; }
}
export class Graph {
  constructor(
    private readonly expectedTenantId:string,
    private readonly credential:GraphCredential=new DefaultAzureCredential({managedIdentityClientId:process.env.MANAGED_IDENTITY_CLIENT_ID}),
    private readonly fetchImpl:GraphFetch=fetch,
  ) {}
  async request(path:string,body?:unknown):Promise<Response> {
    const url=new URL(path,'https://graph.microsoft.com/v1.0/');
    if(url.origin!=='https://graph.microsoft.com'||!url.pathname.startsWith('/v1.0/')||url.username||url.password||url.hash)throw Error('GraphUrlRejected');
    const token=await this.credential.getToken('https://graph.microsoft.com/.default');
    if(!token)throw Error('GraphTokenUnavailable');
    if(tokenTenant(token.token)!==this.expectedTenantId.toLowerCase())throw Error('GraphTenantMismatch');
    const response=await this.fetchImpl(url,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token.token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:'error'});
    if(!response.ok)throw Error(`GraphHttp${response.status}`);
    return response;
  }
  async *audits(from:string,to:string):AsyncGenerator<unknown[]> {
    let path:string|undefined='auditLogs/directoryAudits?'+new URLSearchParams({'$filter':`activityDateTime ge ${from} and activityDateTime le ${to} and category eq 'UserManagement'`,'$top':'100'});
    const seen=new Set<string>();
    while(path){if(seen.has(path))throw Error('GraphPaginationLoop');seen.add(path);const page=await(await this.request(path)).json() as {value:unknown[];'@odata.nextLink'?:string};if(!Array.isArray(page.value))throw Error('GraphInvalidPage');yield page.value;path=page['@odata.nextLink'];}
  }
  async recipient(userId:string):Promise<string> {
    const user=await(await this.request(`users/${encodeURIComponent(userId)}?$select=id,mail,userType`)).json() as {id:string;mail?:string;userType?:string};
    if(user.id.toLowerCase()!==userId.toLowerCase()||user.userType!=='Member'||!user.mail||!/^\S+@\S+\.\S+$/.test(user.mail))throw Error('RecipientMailboxUnavailable');
    return user.mail;
  }
  async email(senderId:string,recipient:string,subject:string,html:string) {
    await this.request(`users/${encodeURIComponent(senderId)}/sendMail`,{message:{subject,body:{contentType:'HTML',content:html},toRecipients:[{emailAddress:{address:recipient}}]},saveToSentItems:true});
  }
}
