class AirHockeyGame {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = canvas.width;
    this.height = canvas.height;
    
    this.isActive = false;
    this.isHost = false;
    this.opponentCallsign = '';
    
    this.score = { p1: 0, p2: 0 }; // p1 is bottom (me), p2 is top (opponent)
    
    // Physics constants
    this.friction = 0.99;
    this.puckRadius = 15;
    this.malletRadius = 25;
    this.goalWidth = 140;
    
    this.resetPositions();

    this.lastLoopTime = performance.now();
    this.networkTickRate = 1000 / 60; // 60 updates per sec
    this.lastNetworkTick = 0;
    
    this.boundLoop = this.loop.bind(this);
    this.boundTouch = this.handleTouch.bind(this);
    
    this.canvas.addEventListener('touchstart', this.boundTouch, { passive: false });
    this.canvas.addEventListener('touchmove', this.boundTouch, { passive: false });
    this.canvas.addEventListener('mousedown', (e) => { this.isMouseDown = true; this.boundTouch(e); });
    this.canvas.addEventListener('mousemove', (e) => { if(this.isMouseDown) this.boundTouch(e); });
    this.canvas.addEventListener('mouseup', () => { this.isMouseDown = false; });
  }

  resetPositions() {
    this.puck = { x: this.width / 2, y: this.height / 2, vx: 0, vy: 0 };
    this.me = { x: this.width / 2, y: this.height - 50 };
    this.opponent = { x: this.width / 2, y: 50 };
  }

  start(isHost, opponentCallsign) {
    this.isHost = isHost;
    this.opponentCallsign = opponentCallsign;
    this.isActive = true;
    this.score = { p1: 0, p2: 0 };
    this.resetPositions();
    this.updateScoreBoard();
    
    if (this.isHost) {
      document.getElementById('gameStatusText').textContent = 'ОЖИДАНИЕ ПРИНЯТИЯ ВЫЗОВА...';
      document.getElementById('gameStatusOverlay').style.display = 'flex';
    } else {
      document.getElementById('gameStatusOverlay').style.display = 'none';
      requestAnimationFrame(this.boundLoop);
    }
  }

  onOpponentAccept(callerName) {
    if (this.isHost) {
      document.getElementById('gameStatusOverlay').style.display = 'none';
      requestAnimationFrame(this.boundLoop);
    }
  }

  stop() {
    this.isActive = false;
  }

  handleTouch(e) {
    e.preventDefault();
    if (!this.isActive || document.getElementById('gameStatusOverlay').style.display !== 'none') return;

    let clientX, clientY;
    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.width / rect.width;
    const scaleY = this.height / rect.height;

    let x = (clientX - rect.left) * scaleX;
    let y = (clientY - rect.top) * scaleY;

    // Constraint mallet to own half
    x = Math.max(this.malletRadius, Math.min(this.width - this.malletRadius, x));
    y = Math.max(this.height / 2 + this.malletRadius, Math.min(this.height - this.malletRadius, y));

    this.me.x = x;
    this.me.y = y;

    // Send position to opponent
    const now = performance.now();
    if (now - this.lastNetworkTick > this.networkTickRate) {
      // Map coordinates for opponent (invert Y, invert X)
      const oppX = this.width - this.me.x;
      const oppY = this.height - this.me.y;
      window.radioNetwork.sendGameMallet(this.opponentCallsign, oppX, oppY);
      this.lastNetworkTick = now;
    }
  }

  onOpponentMallet(x, y) {
    this.opponent.x = x;
    this.opponent.y = y;
  }

  onGameState(state) {
    if (!this.isHost) {
      // Client receives puck and score
      // Inverse coordinates because server sends from its perspective
      this.puck.x = this.width - state.px;
      this.puck.y = this.height - state.py;
      this.puck.vx = -state.pvx;
      this.puck.vy = -state.pvy;
      
      if (this.score.p1 !== state.s2 || this.score.p2 !== state.s1) {
         this.score.p1 = state.s2;
         this.score.p2 = state.s1;
         this.updateScoreBoard();
      }
    }
  }

  updateScoreBoard() {
    document.getElementById('gameScoreBoard').textContent = `${this.score.p2} - ${this.score.p1}`;
    if (window.app && window.app.vibrate) window.app.vibrate([100, 50, 100]);
  }

  checkCollision(mallet) {
    const dx = this.puck.x - mallet.x;
    const dy = this.puck.y - mallet.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const minDist = this.puckRadius + this.malletRadius;

    if (dist < minDist) {
      // Resolve overlap
      const angle = Math.atan2(dy, dx);
      const targetX = mallet.x + Math.cos(angle) * minDist;
      const targetY = mallet.y + Math.sin(angle) * minDist;
      
      this.puck.x = targetX;
      this.puck.y = targetY;

      // Simple elastic bounce
      const speed = Math.max(8, Math.sqrt(this.puck.vx * this.puck.vx + this.puck.vy * this.puck.vy) * 1.1);
      this.puck.vx = Math.cos(angle) * speed;
      this.puck.vy = Math.sin(angle) * speed;
      
      // Limit speed
      const maxSpeed = 20;
      const currentSpeed = Math.sqrt(this.puck.vx * this.puck.vx + this.puck.vy * this.puck.vy);
      if (currentSpeed > maxSpeed) {
         this.puck.vx = (this.puck.vx / currentSpeed) * maxSpeed;
         this.puck.vy = (this.puck.vy / currentSpeed) * maxSpeed;
      }
      
      if (window.app && window.app.vibrate) window.app.vibrate(20);
    }
  }

  loop(timestamp) {
    if (!this.isActive) return;

    if (document.getElementById('gameStatusOverlay').style.display === 'none') {
      if (this.isHost) {
        // HOST PHYSICS
        this.puck.x += this.puck.vx;
        this.puck.y += this.puck.vy;

        this.puck.vx *= this.friction;
        this.puck.vy *= this.friction;

        // Wall collisions
        if (this.puck.x <= this.puckRadius || this.puck.x >= this.width - this.puckRadius) {
          this.puck.vx *= -1;
          this.puck.x = Math.max(this.puckRadius, Math.min(this.width - this.puckRadius, this.puck.x));
        }

        // Goals
        const goalLeft = (this.width - this.goalWidth) / 2;
        const goalRight = goalLeft + this.goalWidth;

        if (this.puck.y <= this.puckRadius) {
          if (this.puck.x > goalLeft && this.puck.x < goalRight) {
            this.score.p1++; // Host scored on opponent
            this.resetPositions();
            this.updateScoreBoard();
          } else {
            this.puck.vy *= -1;
            this.puck.y = this.puckRadius;
          }
        } else if (this.puck.y >= this.height - this.puckRadius) {
          if (this.puck.x > goalLeft && this.puck.x < goalRight) {
            this.score.p2++; // Opponent scored on host
            this.resetPositions();
            this.updateScoreBoard();
          } else {
            this.puck.vy *= -1;
            this.puck.y = this.height - this.puckRadius;
          }
        }

        this.checkCollision(this.me);
        this.checkCollision(this.opponent);

        // Send state to client at 60 FPS
        if (timestamp - this.lastNetworkTick > this.networkTickRate) {
          window.radioNetwork.sendGameState(this.opponentCallsign, {
            px: this.puck.x,
            py: this.puck.y,
            pvx: this.puck.vx,
            pvy: this.puck.vy,
            s1: this.score.p1,
            s2: this.score.p2
          });
          this.lastNetworkTick = timestamp;
        }
      } else {
        // CLIENT PREDICTION (Dead Reckoning)
        // Move the puck smoothly on the client between network updates
        this.puck.x += this.puck.vx;
        this.puck.y += this.puck.vy;
        this.puck.vx *= this.friction;
        this.puck.vy *= this.friction;
      }
    }

    this.draw();
    requestAnimationFrame(this.boundLoop);
  }

  draw() {
    // Clear
    this.ctx.fillStyle = '#111';
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Center line
    this.ctx.beginPath();
    this.ctx.moveTo(0, this.height / 2);
    this.ctx.lineTo(this.width, this.height / 2);
    this.ctx.strokeStyle = 'rgba(0, 255, 102, 0.3)';
    this.ctx.lineWidth = 4;
    this.ctx.stroke();
    
    // Center circle
    this.ctx.beginPath();
    this.ctx.arc(this.width / 2, this.height / 2, 50, 0, Math.PI * 2);
    this.ctx.stroke();

    // Goals
    const goalLeft = (this.width - this.goalWidth) / 2;
    this.ctx.fillStyle = 'rgba(255, 0, 0, 0.2)';
    this.ctx.fillRect(goalLeft, 0, this.goalWidth, 10);
    this.ctx.fillStyle = 'rgba(0, 102, 255, 0.2)';
    this.ctx.fillRect(goalLeft, this.height - 10, this.goalWidth, 10);

    // Puck
    this.ctx.beginPath();
    this.ctx.arc(this.puck.x, this.puck.y, this.puckRadius, 0, Math.PI * 2);
    this.ctx.fillStyle = '#fff';
    this.ctx.shadowBlur = 10;
    this.ctx.shadowColor = '#fff';
    this.ctx.fill();
    this.ctx.shadowBlur = 0;

    // Me (Bottom)
    this.ctx.beginPath();
    this.ctx.arc(this.me.x, this.me.y, this.malletRadius, 0, Math.PI * 2);
    this.ctx.fillStyle = '#00ff66';
    this.ctx.fill();
    this.ctx.strokeStyle = '#000';
    this.ctx.lineWidth = 5;
    this.ctx.stroke();

    // Opponent (Top)
    this.ctx.beginPath();
    this.ctx.arc(this.opponent.x, this.opponent.y, this.malletRadius, 0, Math.PI * 2);
    this.ctx.fillStyle = '#ff3366';
    this.ctx.fill();
    this.ctx.stroke();
  }
}
