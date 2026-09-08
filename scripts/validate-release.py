"""Record the actual command results; never silently convert a failure into a pass."""
import datetime,json,subprocess,re,shutil
from pathlib import Path
root=Path(__file__).resolve().parents[1]
results=[]
for name,command in [('Source syntax and import check',['npm','run','check']),('Node domain/server/adapter tests',['npm','test']),('Static client build',['npm','run','build'])]:
 try:
  p=subprocess.run(command,cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=60)
  results.append({'name':name,'command':' '.join(command),'exitCode':p.returncode,'output':p.stdout})
 except Exception as e:results.append({'name':name,'command':' '.join(command),'exitCode':-1,'output':str(e)})
report=['# Veyra release validation','',f'Generated: {datetime.datetime.now(datetime.timezone.utc).isoformat()}','','These are actual command results. A non-zero exit status is a failed check and must not be described as passed.','', '| Check | Exit status | Result |','|---|---:|---|']
for result in results:report.append(f"| {result['name']} | {result['exitCode']} | {'PASS' if result['exitCode']==0 else 'FAIL — inspect log below'} |")
for result in results:report.extend(['',f"## {result['name']}",'',f"Command: `{result['command']}`",'','```text',result['output'].rstrip(),'```'])
report.extend(['','## Browser and Microsoft boundaries','','Native browser navigation/media can be blocked by environment policy. Component fixtures are not equivalent to a native end-to-end browser pass. No live Microsoft tenant, Entra consent, Graph write, ACS token resource or Teams meeting was independently verified. See VALIDATION.md.'])
(root/'TEST-RESULTS.md').write_text('\n'.join(report)+'\n')
(root/'validation-results.json').write_text(json.dumps(results,indent=2))
if Path('/mnt/data').is_dir():
 shutil.copyfile(root/'TEST-RESULTS.md','/mnt/data/Veyra-Validation.md')
print(json.dumps([{k:v for k,v in r.items() if k!='output'} for r in results],indent=2))
