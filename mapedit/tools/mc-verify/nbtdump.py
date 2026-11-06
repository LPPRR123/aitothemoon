import sys, zlib, struct
def read(b, i, t):
    if t==1: return b[i], i+1
    if t==2: return struct.unpack('>h', b[i:i+2])[0], i+2
    if t==3: return struct.unpack('>i', b[i:i+4])[0], i+4
    if t==4: return struct.unpack('>q', b[i:i+8])[0], i+8
    if t==5: return struct.unpack('>f', b[i:i+4])[0], i+4
    if t==6: return struct.unpack('>d', b[i:i+8])[0], i+8
    if t==7: n=struct.unpack('>i', b[i:i+4])[0]; return ('bytes', n), i+4+n
    if t==8: n=struct.unpack('>H', b[i:i+2])[0]; return b[i+2:i+2+n].decode('utf8','replace'), i+2+n
    if t==9:
        et=b[i]; n=struct.unpack('>i', b[i+1:i+5])[0]; i+=5; out=[]
        for _ in range(n): v,i=read(b,i,et); out.append(v)
        return out, i
    if t==10:
        d={}
        while True:
            tt=b[i]; i+=1
            if tt==0: return d, i
            n=struct.unpack('>H', b[i:i+2])[0]; k=b[i+2:i+2+n].decode(); i+=2+n
            v,i=read(b,i,tt); d[k]=v
    if t==11: n=struct.unpack('>i', b[i:i+4])[0]; return ('ints', n), i+4+4*n
    if t==12: n=struct.unpack('>i', b[i:i+4])[0]; return ('longs', n), i+4+8*n
def chunk(path, cx, cz):
    d=open(path,'rb').read(); j=((cz&31)*32+(cx&31))*4
    e=struct.unpack('>I', d[j:j+4])[0]; off=(e>>8)*4096; ln=struct.unpack('>I', d[off:off+4])[0]
    x=zlib.decompress(d[off+5:off+4+ln]); n=struct.unpack('>H', x[1:3])[0]
    v,_=read(x, 3+n, 10); return v
def short(v, depth=0):
    if isinstance(v, dict): return '{' + ', '.join(f'{k}: {short(x, depth+1)}' for k,x in list(v.items())[:14]) + '}'
    if isinstance(v, list): return f'[{len(v)}× ' + (short(v[0], depth+1) if v else '') + ']'
    return repr(v)[:60]
c=chunk(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
for k,v in c.items():
    if k=='sections':
        print('sections:', len(v)); [print('   ', short(s)) for s in v[3:5]]
    else: print(k, '=', short(v))
