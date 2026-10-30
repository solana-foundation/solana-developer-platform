/*
 * The globe's shaders.
 *
 * The colour every line samples: a soft grey band across the middle of the view, fading toward
 * the poles, turning mint near each landing. The pins are in the globe's own frame, so the green
 * stays on its coast as it turns.
 */
const FIELD_GLSL = `uniform vec3 uHot[4]; uniform float uHotW[4]; uniform float uInk; varying vec3 vView; varying vec3 vLocal;
  vec3 fieldColour(){
    vec2 q = vView.xy;
    float band = exp(-(q.x*q.x)/(2.0*0.95*0.95) - (q.y*q.y)/(2.0*0.6*0.6));
    vec3 grey = mix(vec3(0.984,0.980,0.976), vec3(0.0), uInk * (0.07 + 0.075 * band));
    float w = 0.0;
    for (int i = 0; i < 4; i++) w = max(w, uHotW[i] * smoothstep(0.34, 0.04, distance(vLocal, uHot[i])));
    return mix(grey, vec3(0.475,0.910,0.725), w);
  }`;

export const LINE_VERT = `varying float vU; varying float vFacing; varying vec3 vView; varying vec3 vLocal;
  void main(){ vU = uv.x; vLocal = normalize(position);
    vec3 dir = normalize((modelViewMatrix * vec4(normalize(position), 0.0)).xyz); vFacing = dir.z;
    vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }`;

export const LAND_FRAG = `${FIELD_GLSL}uniform float uOpacity; varying float vU; varying float vFacing;
  void main(){ float a = uOpacity * smoothstep(0.0, 0.42, vFacing); if (a < 0.01) discard; gl_FragColor = vec4(fieldColour(), a); }`;

/*
 * A route: dashes in the field's colour. A live one is drawn in as its payment leaves (uDraw),
 * and the dashes behind the signal (uProg, where it is along the route) turn mint, brightest just
 * behind it.
 */
export const ARC_FRAG = `${FIELD_GLSL}uniform float uOpacity; uniform float uDashes; uniform float uDraw; uniform float uProg; uniform float uMint; varying float vU; varying float vFacing;
  void main(){
    if (vU > uDraw || fract(vU * uDashes) > 0.56) discard;
    float a = uOpacity * smoothstep(0.32, 0.56, vFacing) * smoothstep(0.0, 0.03, vU) * smoothstep(1.0, 0.97, vU); if (a < 0.01) discard;
    float behind = uProg >= 0.0 ? step(vU, uProg) : 0.0, d = uProg - vU, tail = d > 0.0 ? exp(-d * 5.0) : 0.0;
    vec3 c = mix(fieldColour(), vec3(0.475,0.910,0.725), uMint * behind);
    c = mix(c, vec3(0.204,0.847,0.573), uMint * behind * 0.45 * tail);
    gl_FragColor = vec4(c, a); }`;

export const RIM_VERT = `varying vec3 vView; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz; gl_Position = projectionMatrix * mv; }`;

export const RIM_FRAG = `uniform float uOpacity; varying vec3 vView;
  void main(){ float f = 0.55 + 0.45 * smoothstep(1.1, 0.2, abs(vView.y)); gl_FragColor = vec4(vec3(0.933,0.929,0.925), uOpacity * f); }`;
