import type { LiveScene } from "@/lib/use-scene-active";

/*
 * The close's Solana mark as light: three bars drawn as the brand's soft violet light in WebGL,
 * where the glass mark stood, from the middle of the section off its right edge (on a phone, over
 * the headline). They gather the first time the section is reached and breathe; a light follows
 * the pointer over the section and the footer, and wanders a small figure without one. The light
 * parts behind the headline, so the words stand on clean ground. Reduced motion draws one finished
 * frame. Plain WebGL 1, one full-screen triangle and one fragment shader.
 */

const VERTEX = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";

const FRAGMENT = `precision highp float;
uniform vec2 uRes;uniform vec2 uSize;uniform float uT;uniform vec2 uPtr;
uniform vec3 uAsm;uniform vec4 uGeo;uniform float uS;uniform vec4 uClr;uniform float uClrK;
float box(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
float bar(vec2 p,float i,float a,out float rim){
  float H=uGeo.z,G=uGeo.w,W=uSize.x;
  float sg=i==1.?-1.:1.;
  float cy=uGeo.y+(i-1.)*(H+G);
  float dx=(1.-a)*W*.42*sg+10.*sin(uT*.27+i*1.7)+(uPtr.x-W*.5)*.022*(i+1.);
  float x0=uGeo.x+dx;
  float u=p.x-(x0+sg*uS*(cy-p.y)/H);
  float k=H/sqrt(H*H+uS*uS);
  float L=W*3.;
  vec2 q=vec2(u*k-L*k*.5,p.y-cy);
  float d=box(q,vec2(L*k*.5,H*.5),H*.2);
  float b=H*.16*(1.+2.6*(1.-a));
  float body=1.-smoothstep(-b*.7,b,d);
  float haze=exp(-max(d,0.)/(b*2.4))*.38;
  rim=exp(-abs(d)/1.4)*(1.-smoothstep(0.,W*.5,u));
  float shade=mix(1.,.62,clamp(q.y/H+.5,0.,1.));
  float fade=mix(.22,1.,exp(-max(u,0.)/(W*.38)));
  float br=.84+.16*sin(uT*.8+i*2.09);
  return (body*.8*shade+haze)*fade*br*a;
}
void main(){
  vec2 p=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y)/uRes*uSize;
  vec2 S=uSize;
  float R=max(S.x*.17,200.);
  vec2 dp=p-uPtr;float lit=exp(-dot(dp,dp)/(R*R));
  float r0,r1,r2;
  float I=bar(p,0.,uAsm.x,r0)+bar(p,1.,uAsm.y,r1)+bar(p,2.,uAsm.z,r2);
  float rim=(r0*uAsm.x+r1*uAsm.y+r2*uAsm.z);
  I*=.68+1.25*lit;
  I+=lit*.12;rim*=.38+1.6*lit;
  vec2 c=(p-uClr.xy)/uClr.zw;float cl=exp(-dot(c,c)*1.6);
  float ck=uClrK*cl*(1.-.45*lit);I*=1.-ck;
  float vf=smoothstep(0.,min(S.y*.06,40.),p.y)*(1.-smoothstep(S.y*.8,S.y,p.y));
  I*=vf;rim*=vf*(1.-ck);
  float g=exp(-length((p-vec2(S.x*.96,S.y*.02))/vec2(S.x*.34,S.y*.5)))*vf;
  vec3 bg=vec3(.031,.031,.039);
  vec3 col=bg+vec3(.52,.22,1.)*I*.42+vec3(.62,.45,1.)*rim*.32;
  col+=vec3(.10,.98,.61)*g*.05;
  col+=(hash(gl_FragCoord.xy+fract(uT))-.5)/255.*1.6;
  gl_FragColor=vec4(col,1.);
}`;

const UNIFORMS = ["uRes", "uSize", "uT", "uPtr", "uAsm", "uGeo", "uS", "uClr", "uClrK"] as const;

/** Where the mark stands over the headline; start.module.css makes room for it at the same width. */
const NARROW_QUERY = "(max-width: 760px)";
/** The moment the still frame shows: the bars gathered, the light on the top bar's slant. */
const STILL_AT = 24.8;

type Point = { x: number; y: number };

const easeOut = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t === 1 ? 1 : 1 - 2 ** (-10 * t);
};

/**
 * `element`'s layout box in `root`'s coordinates, summed from offsets, so a transform on the way
 * (a block still rising in) does not move it.
 */
function layoutBox(element: HTMLElement, root: Element | null) {
  let left = 0;
  let top = 0;
  let node: Element | null = element;
  while (node instanceof HTMLElement && node !== root) {
    left += node.offsetLeft;
    top += node.offsetTop;
    node = node.offsetParent;
  }
  return { left, top, width: element.offsetWidth, height: element.offsetHeight };
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

/**
 * Draws the light in a canvas of its own (`canvasClassName`) over `host`, clear behind `copy` (the
 * headline). Returns null when WebGL or the shader cannot start; `onLost` hears when the context
 * goes.
 */
export function createCloseLight({
  host,
  copy,
  canvasClassName,
  reducedMotion,
  onLost,
}: {
  host: HTMLElement;
  copy: HTMLElement;
  canvasClassName: string;
  reducedMotion: boolean;
  onLost: () => void;
}): LiveScene | null {
  const canvas = document.createElement("canvas");
  canvas.className = canvasClassName;
  canvas.setAttribute("aria-hidden", "true");
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl", {
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
      powerPreference: "low-power",
    });
  } catch {
    gl = null;
  }
  if (!gl) return null;

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGLRenderingContext.useProgram, not a React hook.
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  // SAFETY: fromEntries over UNIFORMS has exactly one entry per name.
  const u = Object.fromEntries(
    UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])
  ) as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  const context = gl;

  let width = 0;
  let height = 0;
  let geometry = [0, 0, 0, 0];
  let slant = 0;
  let clearing = [0, 0, 1, 1];
  let clearingStrength = 0.5;

  /* the bars set close, as the brand draws them: the gap is half a bar. On a wide screen the mark
     starts past the middle, beside the headline; on a phone it stands over the headline */
  const layout = () => {
    width = host.clientWidth;
    height = host.clientHeight;
    const narrow = window.matchMedia?.(NARROW_QUERY).matches ?? false;
    /* the host covers its section, so both share one origin */
    const words = layoutBox(copy, host.offsetParent);
    if (narrow) {
      const above = words.top;
      const bar = Math.max(28, Math.min(48, (above - 64) / 4.2));
      geometry = [width * 0.12, above / 2 + 8, bar, bar * 0.5];
      slant = bar * 0.78;
    } else {
      const bar = Math.max(64, Math.min(170, height * 0.17, width * 0.12));
      geometry = [width * 0.55, height * 0.42, bar, bar * 0.5];
      slant = bar * 0.78;
    }
    clearing = [
      words.left + words.width / 2,
      words.top + words.height * 0.45,
      Math.max(words.width * 0.62, 160),
      Math.max(words.height * 0.55, 120),
    ];
    clearingStrength = narrow ? 0.6 : 0.5;
    const scale = Math.min(window.devicePixelRatio || 1, 2) * (narrow ? 0.75 : 0.6);
    canvas.width = Math.max(2, Math.round(width * scale));
    canvas.height = Math.max(2, Math.round(height * scale));
    context.viewport(0, 0, canvas.width, canvas.height);
  };

  /* the pointer as it was last seen; a frame places it on the section, so a move costs nothing */
  const hover = window.matchMedia?.("(hover: hover)").matches ?? false;
  const pointer = { x: 0, y: 0, on: false };
  const onPointerMove = (event: PointerEvent) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.on = event.pointerType !== "touch";
  };
  /* out of the window */
  const onPointerOut = (event: PointerEvent) => {
    if (!event.relatedTarget) pointer.on = false;
  };
  /* the pointer on the section, from 40px above it to 240px under it, so the footer counts */
  const pointed = (): Point | null => {
    if (!pointer.on || !hover) return null;
    const box = host.getBoundingClientRect();
    const x = pointer.x - box.left;
    const y = pointer.y - box.top;
    return y > -40 && y < box.height + 240 ? { x, y } : null;
  };
  const wander = (t: number): Point => ({
    x: width * (0.7 + 0.14 * Math.sin(t * 0.21)),
    y: height * (0.42 + 0.16 * Math.sin(t * 0.17 + 1.0)),
  });

  let start = performance.now();
  let last = start;
  let step = 0.016;
  let light: Point | null = null;
  const gathered = [0, 0, 0];

  /* the light catches up with the pointer softly */
  const draw = (t: number, still: boolean) => {
    for (const [index, delay] of [0.1, 0.28, 0.46].entries()) {
      gathered[index] = still ? 1 : easeOut((t - delay) / 1.7);
    }
    const target = (!still && pointed()) || wander(t);
    const ty = Math.min(target.y, height);
    if (!light || still) light = { x: target.x, y: ty };
    else {
      const k = 1 - 0.0025 ** Math.min(0.05, step);
      light.x += (target.x - light.x) * k;
      light.y += (ty - light.y) * k;
    }
    context.uniform2f(u.uRes, canvas.width, canvas.height);
    context.uniform2f(u.uSize, width, height);
    context.uniform1f(u.uT, t);
    context.uniform2f(u.uPtr, light.x, light.y);
    context.uniform3f(u.uAsm, gathered[0], gathered[1], gathered[2]);
    context.uniform4f(u.uGeo, geometry[0], geometry[1], geometry[2], geometry[3]);
    context.uniform1f(u.uS, slant);
    context.uniform4f(u.uClr, clearing[0], clearing[1], clearing[2], clearing[3]);
    context.uniform1f(u.uClrK, clearingStrength);
    context.drawArrays(context.TRIANGLES, 0, 3);
  };

  let frame = 0;
  let running = false;
  /* the bars gather the first time the section is reached, not on page load */
  let met = false;
  const tick = (now: number) => {
    frame = 0;
    if (!running) return;
    step = (now - last) / 1000;
    last = now;
    draw((now - start) / 1000, false);
    frame = requestAnimationFrame(tick);
  };
  const play = () => {
    if (running || reducedMotion) return;
    if (!met) {
      met = true;
      start = performance.now();
    }
    running = true;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  };
  const stop = () => {
    running = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const onContextLost = (event: Event) => {
    event.preventDefault();
    stop();
    onLost();
  };

  host.appendChild(canvas);
  layout();
  draw(reducedMotion ? STILL_AT : 0, reducedMotion);
  const resize = new ResizeObserver(() => {
    layout();
    if (!running)
      draw(reducedMotion ? STILL_AT : (performance.now() - start) / 1000, reducedMotion);
  });
  resize.observe(host);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("pointerout", onPointerOut);
  canvas.addEventListener("webglcontextlost", onContextLost);

  return {
    setActive(active) {
      if (active) play();
      else stop();
    },
    dispose() {
      stop();
      resize.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerout", onPointerOut);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      context.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}
