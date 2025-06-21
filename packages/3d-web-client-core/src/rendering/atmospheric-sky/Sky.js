import {
    BackSide,
    BoxGeometry,
    Mesh,
    ShaderMaterial,
    UniformsUtils,
    Vector3
} from 'three';

/**
 * Represents a skydome for scene backgrounds. Based on [A Practical Analytic Model for Daylight]{@link https://www.researchgate.net/publication/220720443_A_Practical_Analytic_Model_for_Daylight}
 * aka The Preetham Model, the de facto standard for analytical skydomes.
 *
 * Note that this class can only be used with {@link WebGLRenderer}.
 * When using {@link WebGPURenderer}, use {@link SkyMesh}.
 *
 * More references:
 *
 * - {@link http://simonwallner.at/project/atmospheric-scattering/}
 * - {@link http://blenderartists.org/forum/showthread.php?245954-preethams-sky-impementation-HDR}
 *
 *
 * ```js
 * const sky = new Sky();
 * sky.scale.setScalar( 10000 );
 * scene.add( sky );
 * ```
 *
 * @augments Mesh
 */
class Sky extends Mesh {

    /**
     * Constructs a new skydome.
     */
    constructor() {

        const shader = Sky.SkyShader;

        const material = new ShaderMaterial( {
            name: shader.name,
            uniforms: UniformsUtils.clone( shader.uniforms ),
            vertexShader: shader.vertexShader,
            fragmentShader: shader.fragmentShader,
            side: BackSide,
            depthWrite: false
        } );

        super( new BoxGeometry( 1, 1, 1 ), material );

        /**
         * This flag can be used for type testing.
         *
         * @type {boolean}
         * @readonly
         * @default true
         */
        this.isSky = true;

    }

}

Sky.SkyShader = {

    name: 'SkyShader',

    uniforms: {
        'turbidity': { value: 3.5 },
        'rayleigh': { value: 2.5 },
        'mieCoefficient': { value: 0.008 },
        'mieDirectionalG': { value: 0.85 },
        'sunPosition': { value: new Vector3() },
        'up': { value: new Vector3( 0, 1, 0 ) }
    },

    vertexShader: /* glsl */`
        uniform vec3 sunPosition;
        uniform float rayleigh;
        uniform float turbidity;
        uniform float mieCoefficient;
        uniform vec3 up;

        varying vec3 vWorldPosition;
        varying vec3 vSunDirection;
        varying float vSunfade;
        varying vec3 vBetaR;
        varying vec3 vBetaM;
        varying float vSunE;

        // constants for atmospheric scattering
        const float e = 2.71828182845904523536028747135266249775724709369995957;
        const float pi = 3.141592653589793238462643383279502884197169;

        // wavelength of used primaries, according to preetham
        const vec3 lambda = vec3( 680E-9, 550E-9, 450E-9 );
        // Enhanced Rayleigh coefficients with stronger blue component
        const vec3 totalRayleigh = vec3( 5.804542996261093E-6, 1.3562911419845635E-5, 3.5E-5 );

        // mie stuff
        // K coefficient for the primaries
        const float v = 4.0;
        const vec3 K = vec3( 0.686, 0.678, 0.666 );
        // MieConst = pi * pow( ( 2.0 * pi ) / lambda, vec3( v - 2.0 ) ) * K
        const vec3 MieConst = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );

        // earth shadow hack
        // cutoffAngle = pi / 1.95;
        const float cutoffAngle = 1.6110731556870734;
        const float steepness = 1.5;
        const float EE = 1000.0;

        float sunIntensity( float zenithAngleCos ) {
            zenithAngleCos = clamp( zenithAngleCos, -1.0, 1.0 );
            return EE * max( 0.0, 1.0 - pow( e, -( ( cutoffAngle - acos( zenithAngleCos ) ) / steepness ) ) );
        }

        vec3 totalMie( float T ) {
            float c = ( 0.2 * T ) * 10E-18;
            return 0.434 * c * MieConst;
        }

        void main() {

            vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
            vWorldPosition = worldPosition.xyz;

            gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
            gl_Position.z = gl_Position.w; // set z to camera.far

            vSunDirection = normalize( sunPosition );

            vSunE = sunIntensity( dot( vSunDirection, up ) );

            vSunfade = 1.0 - clamp( 1.0 - exp( ( sunPosition.y / 450000.0 ) ), 0.0, 1.0 );

            float rayleighCoefficient = rayleigh - ( 1.0 * ( 1.0 - vSunfade ) );

            // extinction (absorption + out scattering)
            // rayleigh coefficients
            vBetaR = totalRayleigh * rayleighCoefficient;

            // mie coefficients
            vBetaM = totalMie( turbidity ) * mieCoefficient;

        }`,

    fragmentShader: /* glsl */`
        varying vec3 vWorldPosition;
        varying vec3 vSunDirection;
        varying float vSunfade;
        varying vec3 vBetaR;
        varying vec3 vBetaM;
        varying float vSunE;

        uniform float mieDirectionalG;
        uniform vec3 up;

        // constants for atmospheric scattering
        const float pi = 3.141592653589793238462643383279502884197169;

        const float n = 1.0003; // refractive index of air
        const float N = 2.545E25; // number of molecules per unit volume for air at 288.15K and 1013mb (sea level -45 celsius)

        // optical length at zenith for molecules
        const float rayleighZenithLength = 8.4E3;
        const float mieZenithLength = 1.25E3;
        // 66 arc seconds -> degrees, and the cosine of that
        const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;

        // 3.0 / ( 16.0 * pi )
        const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
        // 1.0 / ( 4.0 * pi )
        const float ONE_OVER_FOURPI = 0.07957747154594767;

        float rayleighPhase( float cosTheta ) {
            return THREE_OVER_SIXTEENPI * ( 1.0 + pow( cosTheta, 2.0 ) );
        }

        float hgPhase( float cosTheta, float g ) {
            float g2 = pow( g, 2.0 );
            float inverse = 1.0 / pow( 1.0 - 2.0 * g * cosTheta + g2, 1.5 );
            return ONE_OVER_FOURPI * ( ( 1.0 - g2 ) * inverse );
        }

        void main() {

            vec3 direction = normalize( vWorldPosition - cameraPosition );

            // optical length
            // cutoff angle at 90 to avoid singularity in next formula.
            float zenithAngle = acos( max( 0.0, dot( up, direction ) ) );
            float inverse = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( ( zenithAngle * 180.0 ) / pi ), -1.253 ) );
            float sR = rayleighZenithLength * inverse;
            float sM = mieZenithLength * inverse;

            // combined extinction factor
            vec3 Fex = exp( -( vBetaR * sR + vBetaM * sM ) );

            // in scattering
            float cosTheta = dot( direction, vSunDirection );

            // Improved Rayleigh phase function - removed the artificial modification
            float rPhase = rayleighPhase( cosTheta );
            vec3 betaRTheta = vBetaR * rPhase;

            float mPhase = hgPhase( cosTheta, mieDirectionalG );
            vec3 betaMTheta = vBetaM * mPhase;

            vec3 Lin = pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * ( 1.0 - Fex ), vec3( 1.5 ) );
            Lin *= mix( vec3( 1.0 ), pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * Fex, vec3( 1.0 / 2.0 ) ), clamp( pow( 1.0 - dot( up, vSunDirection ), 5.0 ), 0.0, 1.0 ) );

            // nightsky
            float theta = acos( direction.y ); // elevation --> y-axis, [-pi/2, pi/2]
            float phi = atan( direction.z, direction.x ); // azimuth --> x-axis [-pi/2, pi/2]
            vec2 uv = vec2( phi, theta ) / vec2( 2.0 * pi, pi ) + vec2( 0.5, 0.0 );
            vec3 L0 = vec3( 0.1 ) * Fex;

            // composition + solar disc
            float sundisk = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta );
            L0 += ( vSunE * 19000.0 * Fex ) * sundisk;

            // Enhanced dusk/dawn effects
            float sunElevation = dot( vSunDirection, up );
            float horizonFactor = 1.0 - clamp( sunElevation + 0.1, 0.0, 1.0 ); // Stronger effect when sun is low
            float duskDawnIntensity = pow( horizonFactor, 0.8 ) * 2.0;
            
            // Enhanced color composition with dynamic warm/cool bias
            vec3 warmBias = vec3( 0.008, 0.003, 0.0 ) * duskDawnIntensity; // Red/orange bias for low sun
            vec3 coolBias = vec3( 0.0, 0.001, 0.003 ) * (1.0 - horizonFactor); // Blue bias for high sun
            vec3 texColor = ( Lin + L0 ) * 0.08 + warmBias + coolBias;

            // Enhanced warm color scattering near horizon
            float horizonGlow = smoothstep( 0.7, 1.0, horizonFactor ) * smoothstep( 0.8, 0.95, cosTheta );
            texColor += vec3( 0.15, 0.08, 0.02 ) * horizonGlow * vSunE * 0.0001;

            // Improved tone mapping with enhanced warm color preservation
            float warmPreservation = 1.0 + (horizonFactor * 0.5); // Preserve warm colors during dusk/dawn
            vec3 retColor = pow( texColor, vec3( 1.0 / ( warmPreservation + ( 0.6 * vSunfade ) ) ) );

            gl_FragColor = vec4( retColor, 1.0 );

            #include <tonemapping_fragment>
            #include <colorspace_fragment>

        }`

};

export { Sky }; 