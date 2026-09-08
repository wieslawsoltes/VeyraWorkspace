/** Public identifiers only. Never put an app secret, ACS key, or TURN secret here. */
export const defaultConfig={microsoftClientId:'',microsoftTenantId:'common',useBundledSDKs:false,graphPollMilliseconds:15000};
export function readConfig(){try{return{...defaultConfig,...JSON.parse(localStorage.getItem('veyra.config')||'{}')};}catch{return{...defaultConfig};}}
export function saveConfig(value){
  const client=String(value.microsoftClientId||'').trim(),tenant=String(value.microsoftTenantId||'common').trim();
  if(client&&!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(client))throw new Error('The application client ID must be a GUID.');
  if(!/^(common|organizations|consumers|[\da-f-]{36}|[a-z0-9.-]+\.[a-z]{2,})$/i.test(tenant))throw new Error('Enter a valid tenant ID or tenant domain.');
  const config={...readConfig(),microsoftClientId:client,microsoftTenantId:tenant};localStorage.setItem('veyra.config',JSON.stringify(config));return config;
}
