// Ориентация камеры: гироскоп телефона (deviceorientation) или перетаскивание пальцем/мышью.
import * as THREE from 'three';

const Z = new THREE.Vector3(0, 0, 1);
const Y = new THREE.Vector3(0, 1, 0);
const Q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // камера смотрит из «задней» стороны устройства
const _e = new THREE.Euler();
const _q0 = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _f = new THREE.Vector3();
const D = THREE.MathUtils.degToRad;

export class Look {
  constructor(camera, el) {
    this.cam = camera;
    this.el = el;
    this.gyro = false;
    this.ori = null;
    this.offset = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.q = new THREE.Quaternion();
    this.needRecenter = true;
    this._onOri = (e) => {
      if (e.alpha == null && e.beta == null) return;
      this.ori = { a: e.alpha || 0, b: e.beta || 0, g: e.gamma || 0 };
      if (!this.gyro) this.needRecenter = true;
      this.gyro = true;
    };
    this._bindDrag();
  }

  async enable() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        await DeviceOrientationEvent.requestPermission(); // iOS 13+
      }
    } catch (e) { /* пользователь отказал — останется управление пальцем */ }
    window.addEventListener('deviceorientation', this._onOri);
  }

  screenAngle() {
    const a = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
    return D(a || 0);
  }

  deviceQuat(out) {
    const { a, b, g } = this.ori;
    _e.set(D(b), D(a), -D(g), 'YXZ');
    out.setFromEuler(_e);
    out.multiply(Q1);
    out.multiply(_q0.setFromAxisAngle(Z, -this.screenAngle()));
    return out;
  }

  recenter() {
    this.needRecenter = true;
    this.yaw = 0;
    this.pitch = 0;
  }

  update(dt) {
    if (this.gyro && this.ori) {
      const q = this.deviceQuat(this.q);
      if (this.needRecenter) {
        _f.set(0, 0, -1).applyQuaternion(q);
        this.offset = -Math.atan2(-_f.x, -_f.z);
        this.needRecenter = false;
        _qy.setFromAxisAngle(Y, this.offset);
        this.cam.quaternion.copy(q.premultiply(_qy));
        return;
      }
      _qy.setFromAxisAngle(Y, this.offset);
      q.premultiply(_qy);
      this.cam.quaternion.slerp(q, Math.min(1, dt * 18));
    } else {
      _e.set(this.pitch, this.yaw, 0, 'YXZ');
      this.cam.quaternion.setFromEuler(_e);
    }
  }

  /** Угол поворота взгляда вокруг вертикали (0 = «вперёд», + = налево). */
  yawOf() {
    _f.set(0, 0, -1).applyQuaternion(this.cam.quaternion);
    return Math.atan2(-_f.x, -_f.z);
  }

  _bindDrag() {
    let down = false, px = 0, py = 0;
    const el = this.el;
    el.addEventListener('pointerdown', (e) => { down = true; px = e.clientX; py = e.clientY; });
    window.addEventListener('pointerup', () => { down = false; });
    window.addEventListener('pointermove', (e) => {
      if (!down || this.gyro) return;
      this.yaw += (e.clientX - px) * 0.006;
      this.pitch = THREE.MathUtils.clamp(this.pitch + (e.clientY - py) * 0.005, -1.3, 1.3);
      px = e.clientX;
      py = e.clientY;
    });
    window.addEventListener('keydown', (e) => {
      if (this.gyro) return;
      if (e.key === 'ArrowLeft') this.yaw += 0.12;
      if (e.key === 'ArrowRight') this.yaw -= 0.12;
      if (e.key === 'ArrowUp') this.pitch = Math.min(1.3, this.pitch + 0.08);
      if (e.key === 'ArrowDown') this.pitch = Math.max(-1.3, this.pitch - 0.08);
    });
  }
}
