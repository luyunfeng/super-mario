import type {Store} from '../../plugin-sdk/src/index.ts';

const rateLimits='source.connector-retry'; // Existing numeric Retry-After values remain authoritative.
const failures='source.connector-failures';
type FailureState={count:number;until:number};

export function subscriptionConnectorId(sourceId:string) {
  const separator=sourceId.lastIndexOf('.');
  return separator<0 ? sourceId : sourceId.slice(0,separator);
}

export function createConnectorRetry(store:Store) {
  function get(sourceId:string):{until:number;kind:'rate_limit'|'failures'}|undefined {
    const id=subscriptionConnectorId(sourceId);
    const rate=store.get<number>(rateLimits,id) ?? 0;
    const paused=store.get<FailureState>(failures,id)?.until ?? 0;
    const now=Date.now();
    if(rate>now && rate>=paused) return {until:rate,kind:'rate_limit'};
    if(paused>now) return {until:paused,kind:'failures'};
  }

  function limited(sourceId:string,until:number) {
    if(!Number.isFinite(new Date(until).getTime()) || until<=Date.now()) return;
    const id=subscriptionConnectorId(sourceId);
    store.transaction(()=>{
      if(until>(store.get<number>(rateLimits,id) ?? 0)) store.put(rateLimits,id,until);
    });
  }

  function failed(sourceId:string) {
    const id=subscriptionConnectorId(sourceId);
    store.transaction(()=>{
      const previous=store.get<FailureState>(failures,id);
      // Twelve failures reach the six-hour cap. Larger counts do not change the next delay.
      const count=Math.min((previous?.count ?? 0)+1,12);
      let until=previous?.until ?? 0;
      if(count>=3) until=Math.max(until,Date.now()+Math.min(60_000*2**(count-3),6*3_600_000));
      store.put(failures,id,{count,until});
    });
  }

  function succeeded(sourceId:string) {
    const id=subscriptionConnectorId(sourceId);
    store.transaction(()=>{
      const state=store.get<FailureState>(failures,id);
      if(!state) return;
      // An already dispatched call may finish after another call has imposed a pause.
      if(state.until<=Date.now()) store.remove(failures,id);
      else if(state.count) store.put(failures,id,{...state,count:0});
    });
  }
  return {get,limited,failed,succeeded};
}
