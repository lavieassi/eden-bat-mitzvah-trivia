// Web Audio API Sound Synthesizer for Eden's Bat Mitzvah Trivia
class TriviaAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }

  // Play a short synth note
  playTone(freq, type = 'sine', duration = 0.2, gainVal = 0.15) {
    if (this.muted) return;
    this.init();
    if (!this.ctx) return;

    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);

      gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  }

  // Button Click / Tap
  playClick() {
    this.playTone(600, 'sine', 0.08, 0.1);
  }

  // Timer Tick
  playTick() {
    this.playTone(880, 'triangle', 0.05, 0.05);
  }

  // Timer Warning Tick (last 5 seconds)
  playWarningTick() {
    this.playTone(1200, 'square', 0.08, 0.08);
  }

  // Correct Answer Chime (sparkling major chord)
  playCorrect() {
    if (this.muted) return;
    this.init();
    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    notes.forEach((freq, i) => {
      setTimeout(() => {
        this.playTone(freq, 'sine', 0.35, 0.15);
      }, i * 90);
    });
  }

  // Wrong Answer Buzz
  playWrong() {
    if (this.muted) return;
    this.init();
    const notes = [311.13, 293.66]; // Eb4, D4
    notes.forEach((freq, i) => {
      setTimeout(() => {
        this.playTone(freq, 'sawtooth', 0.25, 0.1);
      }, i * 140);
    });
  }

  // Game / Question Start Gong
  playRoundStart() {
    if (this.muted) return;
    this.init();
    this.playTone(440, 'triangle', 0.15, 0.12);
    setTimeout(() => {
      this.playTone(659.25, 'triangle', 0.3, 0.15);
    }, 150);
  }

  // Grand Finale Fanfare
  playFanfare() {
    if (this.muted) return;
    this.init();
    const melody = [
      { f: 523.25, d: 0.18, pause: 0 },
      { f: 523.25, d: 0.18, pause: 180 },
      { f: 523.25, d: 0.18, pause: 360 },
      { f: 659.25, d: 0.35, pause: 540 },
      { f: 587.33, d: 0.18, pause: 900 },
      { f: 659.25, d: 0.18, pause: 1080 },
      { f: 783.99, d: 0.6, pause: 1260 },
      { f: 1046.50, d: 0.9, pause: 1700 }
    ];

    melody.forEach(item => {
      setTimeout(() => {
        this.playTone(item.f, 'triangle', item.d, 0.2);
      }, item.pause);
    });
  }
}

window.soundEngine = new TriviaAudio();
