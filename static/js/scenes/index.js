import { Projectile } from './projectile.js';
import { Pendulum } from './pendulum.js';
import { Spring } from './spring.js';
import { SpringVertical } from './spring_vertical.js';
import { Incline } from './incline.js';
import { Collision } from './collision.js';
import { Atwood } from './atwood.js';
import { CartPendulum } from './cart_pendulum.js';
import { DoublePendulum } from './double_pendulum.js';
import { TrackScene } from './track.js';

export const SCENES = {
  projectile: Projectile,
  pendulum: Pendulum,
  spring: Spring,
  spring_vertical: SpringVertical,
  incline: Incline,
  collision: Collision,
  atwood: Atwood,
  cart_pendulum: CartPendulum,
  double_pendulum: DoublePendulum,
  track: TrackScene,
};

export function createScene(spec, catalog) {
  const Cls = SCENES[spec.type] ?? Projectile;
  const scene = new Cls(spec, catalog[spec.type]);
  scene.reset();
  return scene;
}

// Example prompts shown as chips (one per scene).
export const EXAMPLES = [
  { type: 'track', text: 'Drop a ball into a semicircular dish with a radius of 5 m, with no friction' },
  { type: 'track', text: 'A roller coaster cart starts on a 12 m hill and goes through a vertical loop of radius 4 m' },
  { type: 'track', text: 'Generate a sine-wave track, place a ball at the bottom of the first valley and push it right at 8 m/s' },
  { type: 'track', text: 'A track following y = 2sin(x) with a ball at x = 0 moving at 5 m/s' },
  { type: 'projectile', text: 'Simulate a ball launched at 25 m/s at 40 degrees' },
  { type: 'cart_pendulum', text: 'A 2 kg cart between two 15 N/m springs with a 1.2 m pendulum hanging from it' },
  { type: 'pendulum', text: 'A 3 m pendulum released from 60° on the Moon' },
  { type: 'double_pendulum', text: 'Show me a chaotic double pendulum starting at 120° and −20°' },
  { type: 'incline', text: 'A 5 kg block on a 35° ramp with friction coefficient 0.4' },
  { type: 'collision', text: 'Two carts collide head-on: 3 kg at 4 m/s and 1 kg at 2 m/s, elastic' },
  { type: 'spring', text: 'A 2 kg block on a spring with k = 50 N/m pulled 30 cm on a rough floor' },
  { type: 'atwood', text: 'Atwood machine with 5 kg and 3 kg masses' },
  { type: 'spring_vertical', text: 'A 500 g mass hanging from a vertical spring of 40 N/m' },
];
