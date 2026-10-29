import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateCodeForSpec } from '../src/codegen.js'
import { runInSandbox } from '../src/sandbox.js'

for (const position of ['auto', 'bottom', 'top']) test(`real Chinese ${position} chart keeps legends outside data and long tick labels apart`, {timeout:120000}, async () => {
 const workdir=fs.mkdtempSync(path.join(os.tmpdir(),'plot-layout-'))
 const measures=Array.from({length:6},(_,i)=>`第${i+1}组长期干预处理后的平均响应指标`)
 const categories=Array.from({length:8},(_,i)=>`第${i+1}次观测窗口的中文分类名称`)
 const csv=['阶段,'+measures.join(','),...categories.map((label,i)=>label+','+measures.map((_,j)=>10+i*2+j).join(','))].join('\n')
 const spec={figure:{title:'不同处理组在连续观测周期中的响应变化与不确定性比较',rows:1,cols:1,fontFamily:'SimHei',dpi:160},panels:[{panel_id:'main',layers:measures.map((label,i)=>({kind:'line',label,color:['#32638D','#2A9D8F','#E9C46A','#E76F51','#9575CD','#78909C'][i]})),scales:[{axis:'x',label:'连续观测周期和采样阶段'},{axis:'y',label:'标准化响应指标'}],legend:{visible:true,position, userSpecified:position!=='auto'}}]}
 const source=generateCodeForSpec(spec,{fileName:'layout.csv',x:'阶段',measures,title:spec.figure.title,yLabel:'标准化响应指标',outputBase:'layout',dpi:160}).python
 const checks=`
fig.canvas.draw()
_r = fig.canvas.get_renderer()
_ax = axes.flat[0]
_legend = _ax.get_legend() or (fig.legends[0] if fig.legends else None)
assert _legend is not None
assert not _legend.get_window_extent(_r).overlaps(_ax.get_window_extent(_r)), 'legend covers plotted data'
if fig._suptitle.get_visible():
    assert not _legend.get_window_extent(_r).overlaps(fig._suptitle.get_window_extent(_r)), 'legend overlaps figure title'
else:
    _title_box = _legend.get_title().get_window_extent(_r)
    assert not any(_title_box.overlaps(_text.get_window_extent(_r)) for _text in _legend.get_texts()), 'legend entries overlap header title'
_ticks = [_t.get_window_extent(_r) for _t in _ax.get_xticklabels() if _t.get_text()]
assert not any(_a.overlaps(_b) for _a, _b in zip(_ticks, _ticks[1:])), 'Chinese category labels overlap: '+str([(b.x0,b.x1) for b in _ticks])
for _artist in [_legend, _ax.xaxis.label, _ax.yaxis.label, (fig._suptitle if fig._suptitle.get_visible() else _legend.get_title()), *_ax.get_xticklabels()]:
    _box = _artist.get_window_extent(_r)
    assert _box.x0 >= -1 and _box.y0 >= -1 and _box.x1 <= fig.bbox.width+1 and _box.y1 <= fig.bbox.height+1, 'text or legend clipped by canvas: '+str((_artist.__class__.__name__,_box.bounds,fig.bbox.bounds))
`
 try {
  const result=await runInSandbox({workdir,engine:'python',code:source+checks,csvName:'layout.csv',csvBuffer:Buffer.from(csv),expected:['layout.svg','layout.png']})
  assert.equal(result.status,'success',result.stderr)
  if(process.env.DEEP_IMAGING_QA_OUTPUT){fs.mkdirSync(process.env.DEEP_IMAGING_QA_OUTPUT,{recursive:true});fs.copyFileSync(path.join(workdir,'layout.png'),path.join(process.env.DEEP_IMAGING_QA_OUTPUT,`chinese-long-labels-${position}.png`))}
 } finally {await fs.promises.rm(workdir,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
})
