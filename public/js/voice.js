(function () {
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  const V = {
    channelId: null,
    serverId: null,
    channelName: '',
    connected: false,
    muted: false,
    deafened: false,
    cameraOn: false,
    screenOn: false,
    localStream: null,
    localVideoTrack: null,
    currentVideoSource: null,
    peers: new Map(),
    pendingCandidates: new Map(),
    audioCtx: null,
    analysers: new Map(),
    speakingSet: new Set(),
    onChange: null,
    api: null
  };

  function emit() {
    if (V.onChange) V.onChange();
  }

  async function post(path, body) {
    return V.api.post(path, body || {});
  }

  function ensureAnalyser(stream, key) {
    try {
      if (!V.audioCtx) V.audioCtx = new AudioContext();
      const src = V.audioCtx.createMediaStreamSource(stream);
      const analyser = V.audioCtx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      V.analysers.set(key, analyser);
    } catch {}
  }

  function startSpeakingLoop() {
    const buf = new Uint8Array(256);
    function loop() {
      if (!V.connected) return;
      for (const [key, analyser] of V.analysers) {
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        const level = sum / buf.length;
        const speaking = level > 12;
        if (speaking !== V.speakingSet.has(key)) {
          if (speaking) V.speakingSet.add(key);
          else V.speakingSet.delete(key);
          emit();
        }
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
  }

  function getPeer(userId) {
    return V.peers.get(userId);
  }

  function bindRemoteTrack(peerId, event) {
    let peer = getPeer(peerId);
    if (!peer) {
      peer = { stream: new MediaStream(), hasVideo: false };
      V.peers.set(peerId, peer);
    }
    const kind = event.track.kind;
    const existing = peer.stream.getTracks().find(t => t.kind === kind);
    if (existing) peer.stream.removeTrack(existing);
    peer.stream.addTrack(event.track);
    if (kind === 'video') {
      peer.hasVideo = true;
      event.track.onmute = () => {
        peer.videoActive = false;
        emit();
      };
      event.track.onunmute = () => {
        peer.videoActive = true;
        emit();
      };
      peer.videoActive = true;
    }
    if (kind === 'audio') {
      ensureAnalyser(peer.stream, peerId);
    }
    emit();
  }

  async function createPeerConnection(peerId, initiator) {
    const old = getPeer(peerId);
    if (old && old.pc) {
      try { old.pc.close(); } catch {}
    }
    const peer = { pc: null, stream: new MediaStream(), hasVideo: false, videoTxAlias: null };
    const pc = new RTCPeerConnection(RTC_CONFIG);
    peer.pc = pc;
    V.peers.set(peerId, peer);

    const audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
    peer.audioSender = audioTx.sender;
    peer.videoSender = videoTx.sender;

    if (V.localStream) {
      const at = V.localStream.getAudioTracks()[0];
      if (at) await peer.audioSender.replaceTrack(at);
    }
    if (V.localVideoTrack) await peer.videoSender.replaceTrack(V.localVideoTrack);

    pc.onicecandidate = e => {
      if (e.candidate) {
        post('/api/signal', { channelId: V.channelId, targetUserId: peerId, payload: { candidate: e.candidate.toJSON() } }).catch(() => {});
      }
    };

    pc.ontrack = e => bindRemoteTrack(peerId, e);

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        emit();
      }
    };

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await post('/api/signal', {
        channelId: V.channelId,
        targetUserId: peerId,
        payload: { sdp: { type: 'offer', sdp: pc.localDescription.sdp } }
      });
    }
    emit();
    return peer;
  }

  async function applyRemoteOffer(peerId, sdp) {
    let peer = getPeer(peerId);
    if (!peer) peer = { pc: null, stream: new MediaStream(), hasVideo: false };
    if (!peer.pc) {
      V.peers.set(peerId, peer);
      const pc = new RTCPeerConnection(RTC_CONFIG);
      peer.pc = pc;

      const audioTx = pc.addTransceiver('audio', { direction: 'sendrecv' });
      const videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
      peer.audioSender = audioTx.sender;
      peer.videoSender = videoTx.sender;

      if (V.localStream) {
        const at = V.localStream.getAudioTracks()[0];
        if (at) await peer.audioSender.replaceTrack(at);
      }
      if (V.localVideoTrack) await peer.videoSender.replaceTrack(V.localVideoTrack);

      pc.onicecandidate = e => {
        if (e.candidate) {
          post('/api/signal', { channelId: V.channelId, targetUserId: peerId, payload: { candidate: e.candidate.toJSON() } }).catch(() => {});
        }
      };
      pc.ontrack = e => bindRemoteTrack(peerId, e);
    }
    const pc = peer.pc;
    await pc.setRemoteDescription({ type: 'offer', sdp: sdp.sdp });
    flushCandidates(peerId);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await post('/api/signal', {
      channelId: V.channelId,
      targetUserId: peerId,
      payload: { sdp: { type: 'answer', sdp: pc.localDescription.sdp } }
    });
    emit();
  }

  function flushCandidates(peerId) {
    const peer = getPeer(peerId);
    const queue = (V.pendingCandidates.get(peerId) || []);
    V.pendingCandidates.set(peerId, []);
    for (const c of queue) {
      if (peer && peer.pc) peer.pc.addIceCandidate(c).catch(() => {});
    }
  }

  V.handleSignal = async function (event) {
    const from = event.fromUserId;
    const payload = event.payload || {};
    try {
      if (payload.sdp) {
        if (payload.sdp.type === 'offer') {
          await applyRemoteOffer(from, payload.sdp);
        } else if (payload.sdp.type === 'answer') {
          const peer = getPeer(from);
          if (peer && peer.pc) {
            await peer.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp.sdp });
            flushCandidates(from);
            emit();
          }
        }
      } else if (payload.candidate) {
        const peer = getPeer(from);
        if (peer && peer.pc && peer.pc.remoteDescription) {
          await peer.pc.addIceCandidate(payload.candidate).catch(() => {});
        } else {
          if (!V.pendingCandidates.has(from)) V.pendingCandidates.set(from, []);
          V.pendingCandidates.get(from).push(payload.candidate);
        }
      }
    } catch (err) {
      console.error('Erro de sinalizacao:', err);
    }
  };

  V.join = async function (channel) {
    if (V.connected) await V.leave(true);
    try {
      V.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true }
      });
    } catch (err) {
      throw new Error('Microfone negado ou indisponivel');
    }
    V.channelId = channel.id;
    V.serverId = channel.serverId;
    V.channelName = channel.name;
    V.peers.clear();
    V.pendingCandidates.clear();

    const res = await post(`/api/channels/${channel.id}/voice/join`);
    V.connected = true;
    ensureAnalyser(V.localStream, 'me');
    startSpeakingLoop();

    const others = (res.users || []).filter(u => u.id !== V.api.me.id);
    for (const u of others) {
      await createPeerConnection(u.id, true);
    }
    emit();
  };

  V.leave = async function (silent) {
    if (!V.connected && !silent) return;
    if (V.channelId && !silent) {
      post(`/api/channels/${V.channelId}/voice/leave`).catch(() => {});
    }
    for (const [, peer] of V.peers) {
      try { if (peer.pc) peer.pc.close(); } catch {}
    }
    V.peers.clear();
    if (V.localStream) {
      V.localStream.getTracks().forEach(t => t.stop());
      V.localStream = null;
    }
    if (V.screenStream) {
      V.screenStream.getTracks().forEach(t => t.stop());
      V.screenStream = null;
    }
    V.localVideoTrack = null;
    V.cameraOn = false;
    V.screenOn = false;
    V.muted = false;
    V.deafened = false;
    V.connected = false;
    V.channelId = null;
    V.serverId = null;
    V.channelName = '';
    V.analysers.clear();
    V.speakingSet.clear();
    emit();
  };

  V.toggleMute = function () {
    if (!V.localStream) return false;
    V.muted = !V.muted;
    V.localStream.getAudioTracks().forEach(t => { t.enabled = !V.muted; });
    emit();
    return V.muted;
  };

  V.toggleDeafen = function () {
    V.deafened = !V.deafened;
    for (const [, peer] of V.peers) {
      peer.stream.getAudioTracks().forEach(t => { t.enabled = !V.deafened; });
    }
    emit();
    return V.deafened;
  };

  async function pushVideoTrack(track) {
    V.localVideoTrack = track;
    for (const [, peer] of V.peers) {
      if (peer.videoSender) await peer.videoSender.replaceTrack(track);
    }
  }

  V.toggleCamera = async function () {
    if (V.cameraOn) {
      if (V.currentVideoSource === 'camera' && V.screenOn && V.screenStream) {
        const st = V.screenStream.getVideoTracks()[0];
        await pushVideoTrack(st);
        V.currentVideoSource = 'screen';
        V.cameraOn = false;
        emit();
        return false;
      }
      V.cameraOn = false;
      if (V.currentVideoSource === 'camera') {
        await pushVideoTrack(null);
        V.currentVideoSource = null;
      }
      emit();
      return false;
    }
    const camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640 }, audio: false });
    V.camStream = camStream;
    const track = camStream.getVideoTracks()[0];
    await pushVideoTrack(track);
    V.cameraOn = true;
    V.currentVideoSource = 'camera';
    track.onended = () => { V.cameraOn = false; emit(); };
    emit();
    return true;
  };

  V.toggleScreen = async function () {
    if (V.screenOn) {
      V.screenOn = false;
      V.screenStream = null;
      if (V.currentVideoSource === 'screen') {
        if (V.cameraOn && V.camStream) {
          await pushVideoTrack(V.camStream.getVideoTracks()[0]);
          V.currentVideoSource = 'camera';
        } else {
          await pushVideoTrack(null);
          V.currentVideoSource = null;
        }
      }
      emit();
      return false;
    }
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    V.screenStream = screenStream;
    const track = screenStream.getVideoTracks()[0];
    await pushVideoTrack(track);
    V.screenOn = true;
    V.currentVideoSource = 'screen';
    track.onended = async () => {
      V.screenOn = false;
      if (V.currentVideoSource === 'screen') {
        if (V.cameraOn && V.camStream) {
          await pushVideoTrack(V.camStream.getVideoTracks()[0]);
          V.currentVideoSource = 'camera';
        } else {
          await pushVideoTrack(null);
          V.currentVideoSource = null;
        }
      }
      emit();
    };
    emit();
    return true;
  };

  window.NexoVoice = V;
})();
