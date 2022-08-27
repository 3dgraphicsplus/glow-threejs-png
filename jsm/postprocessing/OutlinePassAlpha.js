import {
	Color,
	Matrix4,
	NoBlending,
	ShaderMaterial,
	UniformsUtils,
	Vector2,
	Vector3,
	WebGLRenderTarget
} from 'three';
import { Pass, FullScreenQuad } from './Pass.js';
import { CopyShader } from '../shaders/CopyShader.js';

class OutlinePassAlpha extends Pass {

	constructor( resolution, scene, camera ) {

		super();

		this.renderScene = scene;
		this.renderCamera = camera;
		this.visibleEdgeColor = new Color( 1, 0, 0 );
		this.edgeGlow = 1.0;
		this.usePatternTexture = false;
		this.edgeThickness = 3.0;
		this.edgeStrength = 8.0;
		this.downSampleRatio = 2;
		this.pulsePeriod = 0;

		this.resolution = ( resolution !== undefined ) ? new Vector2( resolution.x, resolution.y ) : new Vector2( 256, 256 );

		const resx = Math.round( this.resolution.x / this.downSampleRatio );
		const resy = Math.round( this.resolution.y / this.downSampleRatio );

		this.renderTargetMaskBuffer = new WebGLRenderTarget( this.resolution.x, this.resolution.y );
		this.renderTargetMaskBuffer.texture.name = 'OutlinePassAlpha.mask';
		this.renderTargetMaskBuffer.texture.generateMipmaps = false;

		this.renderTargetDepthBuffer = new WebGLRenderTarget( this.resolution.x, this.resolution.y );
		this.renderTargetDepthBuffer.texture.name = 'OutlinePassAlpha.depth';
		this.renderTargetDepthBuffer.texture.generateMipmaps = false;

		this.renderTargetMaskDownSampleBuffer = new WebGLRenderTarget( resx, resy );
		this.renderTargetMaskDownSampleBuffer.texture.name = 'OutlinePassAlpha.depthDownSample';
		this.renderTargetMaskDownSampleBuffer.texture.generateMipmaps = false;

		this.renderTargetBlurBuffer1 = new WebGLRenderTarget( resx, resy );
		this.renderTargetBlurBuffer1.texture.name = 'OutlinePassAlpha.blur1';
		this.renderTargetBlurBuffer1.texture.generateMipmaps = false;
		this.renderTargetBlurBuffer2 = new WebGLRenderTarget( Math.round( resx / 2 ), Math.round( resy / 2 ) );
		this.renderTargetBlurBuffer2.texture.name = 'OutlinePassAlpha.blur2';
		this.renderTargetBlurBuffer2.texture.generateMipmaps = false;

		this.edgeDetectionMaterial = this.getEdgeDetectionMaterial();
		this.renderTargetEdgeBuffer1 = new WebGLRenderTarget( resx, resy );
		this.renderTargetEdgeBuffer1.texture.name = 'OutlinePassAlpha.edge1';
		this.renderTargetEdgeBuffer1.texture.generateMipmaps = false;
		this.renderTargetEdgeBuffer2 = new WebGLRenderTarget( Math.round( resx / 2 ), Math.round( resy / 2 ) );
		this.renderTargetEdgeBuffer2.texture.name = 'OutlinePassAlpha.edge2';
		this.renderTargetEdgeBuffer2.texture.generateMipmaps = false;

		const MAX_EDGE_THICKNESS = 4;
		const MAX_EDGE_GLOW = 4;

		this.separableBlurMaterial1 = this.getSeperableBlurMaterial( MAX_EDGE_THICKNESS );
		this.separableBlurMaterial1.uniforms[ 'texSize' ].value.set( resx, resy );
		this.separableBlurMaterial1.uniforms[ 'kernelRadius' ].value = 1;
		this.separableBlurMaterial2 = this.getSeperableBlurMaterial( MAX_EDGE_GLOW );
		this.separableBlurMaterial2.uniforms[ 'texSize' ].value.set( Math.round( resx / 2 ), Math.round( resy / 2 ) );
		this.separableBlurMaterial2.uniforms[ 'kernelRadius' ].value = MAX_EDGE_GLOW;

		// Overlay material
		this.overlayMaterial = this.getOverlayMaterial();

		// copy material
		if ( CopyShader === undefined ) console.error( 'THREE.OutlinePassAlpha relies on CopyShader' );

		const copyShader = CopyShader;

		this.copyUniforms = UniformsUtils.clone( copyShader.uniforms );
		this.copyUniforms[ 'opacity' ].value = 1.0;

		this.materialCopy = new ShaderMaterial( {
			uniforms: this.copyUniforms,
			vertexShader: copyShader.vertexShader,
			fragmentShader: copyShader.fragmentShader,
			blending: NoBlending,
			depthTest: false,
			depthWrite: false,
			transparent: true
		} );

		this.enabled = true;
		this.needsSwap = false;

		this._oldClearColor = new Color();
		this.oldClearAlpha = 1;

		this.fsQuad = new FullScreenQuad( null );

		this.tempPulseColor1 = new Color();
		this.tempPulseColor2 = new Color();
		this.textureMatrix = new Matrix4();

	}

	dispose() {

		this.renderTargetMaskBuffer.dispose();
		this.renderTargetDepthBuffer.dispose();
		this.renderTargetMaskDownSampleBuffer.dispose();
		this.renderTargetBlurBuffer1.dispose();
		this.renderTargetBlurBuffer2.dispose();
		this.renderTargetEdgeBuffer1.dispose();
		this.renderTargetEdgeBuffer2.dispose();

	}

	setSize( width, height ) {

		this.renderTargetMaskBuffer.setSize( width, height );
		this.renderTargetDepthBuffer.setSize( width, height );

		let resx = Math.round( width / this.downSampleRatio );
		let resy = Math.round( height / this.downSampleRatio );
		this.renderTargetMaskDownSampleBuffer.setSize( resx, resy );
		this.renderTargetBlurBuffer1.setSize( resx, resy );
		this.renderTargetEdgeBuffer1.setSize( resx, resy );
		this.separableBlurMaterial1.uniforms[ 'texSize' ].value.set( resx, resy );

		resx = Math.round( resx / 2 );
		resy = Math.round( resy / 2 );

		this.renderTargetBlurBuffer2.setSize( resx, resy );
		this.renderTargetEdgeBuffer2.setSize( resx, resy );

		this.separableBlurMaterial2.uniforms[ 'texSize' ].value.set( resx, resy );

	}

	render( renderer, writeBuffer, readBuffer, deltaTime, maskActive ) {

			renderer.getClearColor( this._oldClearColor );
			this.oldClearAlpha = renderer.getClearAlpha();
			const oldAutoClear = renderer.autoClear;

			renderer.autoClear = false;

			if ( maskActive ) renderer.state.buffers.stencil.setTest( false );

			renderer.setClearColor( 0x000000, 0.0 );


			// 1. Draw Non Selected objects in the depth buffer
			renderer.setRenderTarget( this.renderTargetDepthBuffer );
			renderer.clear();
			renderer.render( this.renderScene, this.renderCamera );


			this.renderTargetMaskBuffer = this.renderTargetDepthBuffer;

			// 2. Downsample to Half resolution
			this.fsQuad.material = this.materialCopy;
			this.copyUniforms[ 'tDiffuse' ].value = this.renderTargetMaskBuffer.texture;
			renderer.setRenderTarget( this.renderTargetMaskDownSampleBuffer );
			renderer.clear();
			this.fsQuad.render( renderer );

			this.tempPulseColor1.copy( this.visibleEdgeColor );

			if ( this.pulsePeriod > 0 ) {

				const scalar = ( 1 + 0.25 ) / 2 + Math.cos( performance.now() * 0.01 / this.pulsePeriod ) * ( 1.0 - 0.25 ) / 2;
				this.tempPulseColor1.multiplyScalar( scalar );

			}

			// 3. Apply Edge Detection Pass
			this.fsQuad.material = this.edgeDetectionMaterial;
			this.edgeDetectionMaterial.uniforms[ 'maskTexture' ].value = this.renderTargetMaskDownSampleBuffer.texture;
			this.edgeDetectionMaterial.uniforms[ 'texSize' ].value.set( this.renderTargetMaskDownSampleBuffer.width, this.renderTargetMaskDownSampleBuffer.height );
			this.edgeDetectionMaterial.uniforms[ 'visibleEdgeColor' ].value = this.tempPulseColor1;
			renderer.setRenderTarget( this.renderTargetEdgeBuffer1 );
			renderer.clear();
			this.fsQuad.render( renderer );

			// 4. Apply Blur on Half res
			this.fsQuad.material = this.separableBlurMaterial1;
			this.separableBlurMaterial1.uniforms[ 'colorTexture' ].value = this.renderTargetEdgeBuffer1.texture;
			this.separableBlurMaterial1.uniforms[ 'direction' ].value = OutlinePassAlpha.BlurDirectionX;
			this.separableBlurMaterial1.uniforms[ 'kernelRadius' ].value = this.edgeThickness;
			renderer.setRenderTarget( this.renderTargetBlurBuffer1 );
			renderer.clear();
			this.fsQuad.render( renderer );
			this.separableBlurMaterial1.uniforms[ 'colorTexture' ].value = this.renderTargetBlurBuffer1.texture;
			this.separableBlurMaterial1.uniforms[ 'direction' ].value = OutlinePassAlpha.BlurDirectionY;
			renderer.setRenderTarget( this.renderTargetEdgeBuffer1 );
			renderer.clear();
			this.fsQuad.render( renderer );

			// Apply Blur on quarter res
			this.fsQuad.material = this.separableBlurMaterial2;
			this.separableBlurMaterial2.uniforms[ 'colorTexture' ].value = this.renderTargetEdgeBuffer1.texture;
			this.separableBlurMaterial2.uniforms[ 'direction' ].value = OutlinePassAlpha.BlurDirectionX;
			renderer.setRenderTarget( this.renderTargetBlurBuffer2 );
			renderer.clear();
			this.fsQuad.render( renderer );
			this.separableBlurMaterial2.uniforms[ 'colorTexture' ].value = this.renderTargetBlurBuffer2.texture;
			this.separableBlurMaterial2.uniforms[ 'direction' ].value = OutlinePassAlpha.BlurDirectionY;
			renderer.setRenderTarget( this.renderTargetEdgeBuffer2 );
			renderer.clear();
			this.fsQuad.render( renderer );

			// Blend it additively over the input texture
			this.fsQuad.material = this.overlayMaterial;
			this.overlayMaterial.uniforms[ 'maskTexture' ].value = this.renderTargetMaskBuffer.texture;
			this.overlayMaterial.uniforms[ 'edgeTexture1' ].value = this.renderTargetEdgeBuffer1.texture;
			this.overlayMaterial.uniforms[ 'edgeTexture2' ].value = this.renderTargetEdgeBuffer2.texture;
			this.overlayMaterial.uniforms[ 'patternTexture' ].value = this.patternTexture;
			this.overlayMaterial.uniforms[ 'edgeStrength' ].value = this.edgeStrength;
			this.overlayMaterial.uniforms[ 'edgeGlow' ].value = this.edgeGlow;
			this.overlayMaterial.uniforms[ 'usePatternTexture' ].value = this.usePatternTexture;


			if ( maskActive ) renderer.state.buffers.stencil.setTest( true );

			renderer.setRenderTarget( readBuffer );
			this.fsQuad.render( renderer );

			renderer.setClearColor( this._oldClearColor, this.oldClearAlpha );
			renderer.autoClear = oldAutoClear;

		if ( this.renderToScreen ) {

			this.fsQuad.material = this.materialCopy;
			this.copyUniforms[ 'tDiffuse' ].value = readBuffer.texture;
			renderer.setRenderTarget( null );
			this.fsQuad.render( renderer );

		}

	}

	//detect outline by png alpha
	getEdgeDetectionMaterial() {

		return new ShaderMaterial( {

			uniforms: {
				'maskTexture': { value: null },
				'texSize': { value: new Vector2( 0.5, 0.5 ) },
				'visibleEdgeColor': { value: new Vector3( 1.0, 0.0, 0.0 ) }
			},

			vertexShader:
				`varying vec2 vUv;

				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,

			fragmentShader:
				`varying vec2 vUv;

				uniform sampler2D maskTexture;
				uniform vec2 texSize;
				uniform vec3 visibleEdgeColor;

				void main() {
					vec2 invSize = 1.0 / texSize;
					vec4 uvOffset = vec4(1.0, 0.0, 0.0, 1.0) * vec4(invSize, invSize);
					vec4 c = texture2D( maskTexture, vUv);
					vec4 c1 = texture2D( maskTexture, vUv + uvOffset.xy);
					vec4 c2 = texture2D( maskTexture, vUv - uvOffset.xy);
					vec4 c3 = texture2D( maskTexture, vUv + uvOffset.yw);
					vec4 c4 = texture2D( maskTexture, vUv - uvOffset.yw);
					float diff1 = (c1.a - c2.a)*0.5;
					float diff2 = (c3.a - c4.a)*0.5;
					float d = length( vec2(diff1, diff2) );
					float a1 = min(c1.a, c2.a);
					float a2 = min(c3.a, c4.a);
					vec3 edgeColor = visibleEdgeColor;
					gl_FragColor = vec4(edgeColor, d/2.0);
				}`
		} );

	}

	//create blur version
	getSeperableBlurMaterial( maxRadius ) {

		return new ShaderMaterial( {

			defines: {
				'MAX_RADIUS': maxRadius,
			},

			uniforms: {
				'colorTexture': { value: null },
				'texSize': { value: new Vector2( 0.5, 0.5 ) },
				'direction': { value: new Vector2( 0.5, 0.5 ) },
				'kernelRadius': { value: 1.0 }
			},

			vertexShader:
				`varying vec2 vUv;

				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,

			fragmentShader:
				`#include <common>
				varying vec2 vUv;
				uniform sampler2D colorTexture;
				uniform vec2 texSize;
				uniform vec2 direction;
				uniform float kernelRadius;

				float gaussianPdf(in float x, in float sigma) {
					return 0.39894 * exp( -0.5 * x * x/( sigma * sigma))/sigma;
				}

				void main() {
					vec2 invSize = 1.0 / texSize;
					float sigma = kernelRadius/2.0;
					float weightSum = gaussianPdf(0.0, sigma);
					vec4 c = texture2D( colorTexture, vUv);
					vec4 diffuseSum = c * weightSum;
					vec2 delta = direction * invSize * kernelRadius/float(MAX_RADIUS);
					vec2 uvOffset = delta;
					for( int i = 1; i <= MAX_RADIUS; i ++ ) {
						float x = kernelRadius * float(i) / float(MAX_RADIUS);
						float w = gaussianPdf(x, sigma);
						vec4 sample1 = texture2D( colorTexture, vUv + uvOffset);
						vec4 sample2 = texture2D( colorTexture, vUv - uvOffset);
						diffuseSum += ((sample1 + sample2) * w);
						weightSum += (2.0 * w);
						uvOffset += delta;
					}
					gl_FragColor = diffuseSum/weightSum * (1.0 - c.a);
				}`
		} );

	}

	//merge into final rendering
	getOverlayMaterial() {

		return new ShaderMaterial( {

			uniforms: {
				'maskTexture': { value: null },
				'edgeTexture1': { value: null },
				'edgeTexture2': { value: null },
				'patternTexture': { value: null },
				'edgeStrength': { value: 1.0 },
				'edgeGlow': { value: 1.0 },
				'usePatternTexture': { value: 0.0 }
			},

			vertexShader:
				`varying vec2 vUv;

				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,

			fragmentShader:
				`varying vec2 vUv;

				uniform sampler2D maskTexture;
				uniform sampler2D edgeTexture1;
				uniform sampler2D edgeTexture2;
				uniform sampler2D patternTexture;
				uniform float edgeStrength;
				uniform float edgeGlow;
				uniform bool usePatternTexture;

				void main() {
					vec4 edgeValue1 = texture2D(edgeTexture1, vUv);
					vec4 edgeValue2 = texture2D(edgeTexture2, vUv);
					vec4 maskColor = texture2D(maskTexture, vUv);
					vec4 edgeValue = vec4(step(0.1,edgeValue1.rgb),step(0.1/edgeStrength,edgeValue1.a));
					vec4 glowValue =  edgeValue2 * edgeGlow;
					edgeValue += vec4(glowValue.rgb, glowValue.a*(1.0-step(0.01,maskColor.a)));

					gl_FragColor = edgeValue;//vec4(finalColor,edgeValue.a);
				}`,
			//blending: CustomBlending,
			depthTest: false,
			depthWrite: false,
			transparent: true,
		} );

	}

}

OutlinePassAlpha.BlurDirectionX = new Vector2( 1.0, 0.0 );
OutlinePassAlpha.BlurDirectionY = new Vector2( 0.0, 1.0 );

export { OutlinePassAlpha };
