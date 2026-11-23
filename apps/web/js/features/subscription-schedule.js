import { h } from '../lib/dom.js';
import { Field, Input, Select } from '../ui/kit.js';

export function subscriptionScheduleLabel(row,timezone) {
  return row.mode === 'snapshot' && row.dailyAt ? '每天 '+row.dailyAt+'（'+(timezone || '工作台简报时区')+'）' : '每 '+row.intervalMinutes+' 分钟';
}

export function subscriptionSchedule() {
  const cadence=Select({options:[['daily','每天定时'],['interval','固定间隔']]});
  const time=Input({type:'time',step:60,required:true,value:'08:00'});
  const minutes=Input({type:'number',min:1,max:10080,step:1,required:true,value:60});
  const cadenceField=Field({label:'快照检查方式',control:cadence});
  const timeField=Field({label:'每天检查时间（工作台简报时区）',control:time});
  const minutesField=Field({label:'拉取间隔（分钟）',control:minutes});
  const element=h('div',{class:'stack'},cadenceField,timeField,minutesField);
  let snapshot=false;
  function paint() {
    cadenceField.hidden=!snapshot;
    const daily=snapshot && cadence.value==='daily';
    timeField.hidden=!daily;time.disabled=!daily;
    minutesField.hidden=daily;minutes.disabled=daily;minutes.min=snapshot?'60':'1';
  }
  function set(row={}) {
    snapshot=row.mode==='snapshot';
    cadence.value=row.dailyAt===''?'interval':'daily';
    time.value=row.dailyAt || '08:00';
    minutes.value=String(row.intervalMinutes ?? (snapshot?1440:60));
    paint();
  }
  cadence.addEventListener('change',paint);
  set();
  return {element,set,setTimezone(zone) {
    timeField.querySelector('label').textContent='每天检查时间（'+(zone || '工作台简报时区')+'）';
  },input() {
    if(snapshot && cadence.value==='daily') return {dailyAt:time.value,intervalMinutes:1440};
    return {...(snapshot && {dailyAt:''}),intervalMinutes:Number(minutes.value)};
  }};
}
