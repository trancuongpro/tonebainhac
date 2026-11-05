const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const RECORD_TIME_MS = 8000;

// Hồ sơ Krumhansl-Kessler
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const listenBtn = document.getElementById('listenBtn');
const toneDisplay = document.getElementById('toneDisplay');
const toneType = document.getElementById('toneType');
const statusText = document.getElementById('statusText');
const progressFill = document.getElementById('progressFill');
const glowRing = document.getElementById('glowRing');
const chromaBarsContainer = document.getElementById('chromaBars');

let audioCtx = null;
let analyser = null;
let micStream = null;
let isAnalyzing = false;
let chromaAccum = new Array(12).fill(0);
let sampleInterval = null;

function initChromaBars() {
  chromaBarsContainer.innerHTML = '';
  NOTES.forEach((note, idx) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'chroma-bar-wrapper';
    const bar = document.createElement('div');
    bar.className = 'chroma-bar';
    bar.id = `bar-${idx}`;
    const label = document.createElement('div');
    label.className = 'chroma-label';
    label.innerText = note.replace('#', '♯');
    wrapper.appendChild(bar);
    wrapper.appendChild(label);
    chromaBarsContainer.appendChild(wrapper);
  });
}
initChromaBars();

function freqToNoteIndex(freq) {
  if (!freq || freq < 27.5 || freq > 5000) return -1;
  const midi = Math.round(12 * Math.log2(freq / 440) + 69);
  return ((midi % 12) + 12) % 12;
}

function pearsonCorrelation(x, y) {
  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((a, b, i) => a + b * y[i], 0);
  const sumX2 = x.reduce((a, b) => a + b * b, 0);
  const sumY2 = y.reduce((a, b) => a + b * b, 0);
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return denominator === 0 ? 0 : numerator / denominator;
}

function rotateProfile(profile, root) {
  return profile.map((_, i) => profile[(i - root + 12) % 12]);
}

function detectKey(chroma) {
  let bestScore = -Infinity;
  let bestKey = 0;
  let bestScale = 'major';

  for (let root = 0; root < 12; root++) {
    const majorScore = pearsonCorrelation(chroma, rotateProfile(MAJOR_PROFILE, root));
    if (majorScore > bestScore) {
      bestScore = majorScore;
      bestKey = root;
      bestScale = 'major';
    }
    const minorScore = pearsonCorrelation(chroma, rotateProfile(MINOR_PROFILE, root));
    if (minorScore > bestScore) {
      bestScore = minorScore;
      bestKey = root;
      bestScale = 'minor';
    }
  }
  return { keyIndex: bestKey, key: NOTES[bestKey], scale: bestScale, strength: bestScore };
}

function normalizeChroma(chroma) {
  const max = Math.max(...chroma, 1e-9);
  return chroma.map(v => v / max);
}

async function startListening() {
  if (isAnalyzing) return;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    // Tạo mới AudioContext nếu chưa có hoặc đã bị đóng
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } else if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.2;

    const source = audioCtx.createMediaStreamSource(micStream);
    source.connect(analyser);

    startAnalysisProcess();
  } catch (err) {
    console.error(err);
    statusText.innerText = '❌ Không thể truy cập Micro!';
  }
}

function startAnalysisProcess() {
  isAnalyzing = true;
  chromaAccum.fill(0);

  listenBtn.disabled = true;
  glowRing.classList.add('listening');
  toneDisplay.innerText = '...';
  toneType.innerText = 'Đang lắng nghe âm thanh...';

  const startTime = Date.now();

  sampleInterval = setInterval(() => {
    if (!analyser) return;

    const elapsedTime = Date.now() - startTime;
    const progress = Math.min((elapsedTime / RECORD_TIME_MS) * 100, 100);
    progressFill.style.width = `${progress}%`;
    statusText.innerText = `Đang phân tích phổ âm: ${(elapsedTime / 1000).toFixed(1)}s / ${RECORD_TIME_MS / 1000}s`;

    const freqBuffer = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(freqBuffer);
    const binWidth = audioCtx.sampleRate / analyser.fftSize;

    const frameChroma = new Array(12).fill(0);

    // Sử dụng ngưỡng dB, không dùng trọng số tự phát
    for (let i = 1; i < freqBuffer.length; i++) {
      const freq = i * binWidth;
      if (freq < 60 || freq > 5000) continue;

      const db = freqBuffer[i];
      if (db < -60) continue;

      const noteIdx = freqToNoteIndex(freq);
      if (noteIdx === -1) continue;

      // Chỉ dùng biên độ tuyến tính, bỏ trọng số 1/sqrt(freq/440)
      const amp = Math.pow(10, db / 20);
      frameChroma[noteIdx] += amp;
    }

    const frameSum = frameChroma.reduce((a, b) => a + b, 0);
    if (frameSum < 0.001) {
      updateChromaVisualizer();
      return;
    }

    const frameMax = Math.max(...frameChroma, 1e-9);
    for (let i = 0; i < 12; i++) {
      chromaAccum[i] += frameChroma[i] / frameMax;
    }

    updateChromaVisualizer();

    if (elapsedTime >= RECORD_TIME_MS) {
      clearInterval(sampleInterval);
      sampleInterval = null;
      stopAndCalculateKey();
    }
  }, 100);
}

function updateChromaVisualizer() {
  const normalized = normalizeChroma(chromaAccum);
  normalized.forEach((val, idx) => {
    const bar = document.getElementById(`bar-${idx}`);
    if (bar) {
      bar.style.height = `${Math.min(Math.max(val * 100, 5), 100)}%`;
    }
  });
}

function stopAndCalculateKey() {
  if (micStream) {
    micStream.getTracks().forEach(track => track.stop());
    micStream = null;
  }

  // Không đóng AudioContext ngay — để tái sử dụng cho lần đo sau
  // Chỉ đóng khi thực sự cần (ví dụ trước khi unload trang)
  analyser = null;

  glowRing.classList.remove('listening');
  listenBtn.disabled = false;
  isAnalyzing = false;

  const totalEnergy = chromaAccum.reduce((a, b) => a + b, 0);
  if (totalEnergy < 0.5) {
    toneDisplay.innerText = '--';
    toneType.innerText = 'Không đủ âm thanh để phân tích';
    statusText.innerText = 'Hãy thử lại với âm lượng lớn hơn.';
    return;
  }

  const finalChroma = normalizeChroma(chromaAccum);
  const result = detectKey(finalChroma);

  document.querySelectorAll('.chroma-bar').forEach(b => b.classList.remove('active'));
  const winningBar = document.getElementById(`bar-${result.keyIndex}`);
  if (winningBar) winningBar.classList.add('active');

  const scaleVietnamese = result.scale === 'major' ? 'Trưởng' : 'Thứ';
  toneDisplay.innerText = result.key;
  const confidence = Math.round(Math.max(0, result.strength) * 100);
  toneType.innerText = `Chủ âm: ${result.key} ${scaleVietnamese} (độ tin cậy: ${confidence}%)`;
  statusText.innerText = 'Hoàn tất! Bấm để đo lại.';

  console.log('Chroma:', finalChroma.map(v => v.toFixed(3)).join(', '));
  console.log('Kết quả:', result);
}

listenBtn.addEventListener('click', startListening);