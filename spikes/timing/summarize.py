import json,statistics as st,collections
rows=[json.loads(l) for l in open('results.jsonl')]
g=collections.defaultdict(list)
for r in rows: g[r['delayS']].append(r)
def s(v):
    v=[x for x in v if x is not None]
    return f"{min(v)}/{int(st.median(v))}/{max(v)}" if v else '-'
print("delay n ok | buyerSign | sig->srv | verify | authAge@settle | settle | recSign | e2e")
for d in sorted(g):
    rs=g[d]; ok=sum(1 for r in rs if r['status']==200)
    print(d,len(rs),ok,'|',s([r['buyerSignMs'] for r in rs]),'|',s([r['sigToServerMs'] for r in rs]),'|',s([r['verifyMs'] for r in rs]),'|',s([r['authAgeAtSettleStartMs'] for r in rs]),'|',s([r['settleMs'] for r in rs]),'|',s([int(r['recordSignMs']) if r.get('recordSignMs') else None for r in rs]),'|',s([r['e2eMs'] for r in rs]))
    for r in rs:
        if r['status']!=200: print('   FAIL',r['status'],r.get('errorBody'),r.get('settleReason'),r.get('verifyReason'))
print('ledgersAhead',s([r['ledgersAhead'] for r in rows]),'expSecondsAhead',s([r['expSecondsAhead'] for r in rows]),'first RT',s([r['firstRoundtripMs'] for r in rows]))
