import { escapeHtmlAttribute } from './cuttingScreenUtils.js'
import { buildSeatTargetRuntimeHelpers } from './cuttingRuntimeHelpers.js'

export function buildLastThreeAutoStartHandler(dealCardHtml, dealerPosition) {
  const safeDealCardHtml = JSON.stringify(dealCardHtml)
  const safeDealerPosition = JSON.stringify(dealerPosition)

  return escapeHtmlAttribute(`
    if (window.__belotLastThreeAnimationRunning) {
      return;
    }

    const root = this.closest('[data-cutting-root]');
    const animationLayer = root ? root.querySelector('[data-cutting-animation-layer]') : null;
    const stackDeck = root ? root.querySelector('[data-last-three-stack]') : null;

    if (!root || !animationLayer) {
      if (window.game && window.renderGame) {
        window.game.confirmLastThreeDeal();
        window.renderGame();
      }
      return;
    }

    if (root.dataset.lastThreeStarted === '1') {
      return;
    }

    root.dataset.lastThreeStarted = '1';
    window.__belotLastThreeAnimationRunning = true;

    const dealerPositionValue = ${safeDealerPosition};
    const dealMarkup = ${safeDealCardHtml};

    ${buildSeatTargetRuntimeHelpers()}

    const targets = getSeatTargets(root);
    const seatOrder = getSeatOrderAfterDealerCounterClockwiseRuntime(dealerPositionValue);

    function createDealCard(orderIndex) {
      const cardNode = document.createElement('div');
      cardNode.style.position = 'absolute';
      cardNode.style.left = '50%';
      cardNode.style.top = '50%';
      cardNode.style.width = 'clamp(72px, 5.2vw, 90px)';
      cardNode.style.height = 'clamp(108px, 7.9vw, 136px)';
      cardNode.style.pointerEvents = 'none';
      cardNode.style.zIndex = String(900 + orderIndex);
      cardNode.style.transform =
        'translate(-50%, -50%) translate(0px, 0px) rotate(0deg) scale(1)';
      cardNode.style.transition =
        'transform 0.56s ease, opacity 0.18s linear, filter 0.18s ease';
      cardNode.style.filter = 'drop-shadow(0 4px 8px rgba(0,0,0,0.10))';
      cardNode.innerHTML = dealMarkup;
      animationLayer.appendChild(cardNode);
      return cardNode;
    }

    function launchCard(cardNode, targetKey, spreadOffset, cardInPacketIndex, packetSize) {
      const target = targets[targetKey];
      const centeredOffset = cardInPacketIndex - (packetSize - 1) / 2;

      const extraX =
        targetKey === 'left'
          ? -spreadOffset * 5
          : targetKey === 'right'
            ? spreadOffset * 5
            : centeredOffset * 12;

      const extraY =
        targetKey === 'top'
          ? -spreadOffset * 4 + centeredOffset * -3
          : targetKey === 'bottom'
            ? spreadOffset * 4 + centeredOffset * 3
            : centeredOffset * 10;

      const extraRotate =
        targetKey === 'bottom'
          ? centeredOffset * 4
          : targetKey === 'top'
            ? centeredOffset * -4
            : centeredOffset * 3;

      const scale = targetKey === 'bottom' ? 1 : 0.9;
      const baseRotate = getSeatBaseRotate(targetKey);

      requestAnimationFrame(() => {
        cardNode.style.transform =
          'translate(-50%, -50%) translate(' +
          (target.x + extraX) +
          'px, ' +
          (target.y + extraY) +
          'px) rotate(' +
          (baseRotate + extraRotate) +
          'deg) scale(' +
          scale +
          ')';
      });
    }

    function dealPacketToSeat(targetKey, packetSize, startDelay, baseOrderIndex, seatIndex) {
      const seatDelay = seatIndex * 150;

      for (let i = 0; i < packetSize; i += 1) {
        const orderIndex = baseOrderIndex + i;
        const cardNode = createDealCard(orderIndex);
        const spreadOffset = Math.floor(orderIndex / 4);
        const innerDelay = i * 30;

        setTimeout(() => {
          launchCard(cardNode, targetKey, spreadOffset, i, packetSize);
        }, startDelay + seatDelay + innerDelay);

        setTimeout(() => {
          cardNode.style.opacity = '0';
        }, startDelay + seatDelay + innerDelay + 360);

        setTimeout(() => {
          cardNode.remove();
        }, startDelay + seatDelay + innerDelay + 620);
      }
    }

    if (stackDeck) {
      stackDeck.style.opacity = '1';
      stackDeck.style.transform = 'translate(-50%, -50%) scale(1)';
    }

    let dealtOrderIndex = 0;

    seatOrder.forEach((seatKey, seatIndex) => {
      dealPacketToSeat(seatKey, 3, 80, dealtOrderIndex, seatIndex);
      dealtOrderIndex += 3;
    });

    setTimeout(() => {
      if (stackDeck) {
        stackDeck.style.opacity = '0';
        stackDeck.style.transform = 'translate(-50%, -50%) scale(0.96)';
      }
    }, 180);

    setTimeout(() => {
      window.__belotLastThreeAnimationRunning = false;

      if (window.game && window.renderGame) {
        window.game.confirmLastThreeDeal();
        window.renderGame();
      }
    }, 1180);
  `)
}

function buildCutAnimationRunnerScript(dealCardHtml) {
  const safeDealCardHtml = JSON.stringify(dealCardHtml)

  return `
    window.__belotRunCutAnimation = function(button, cutIndex, dealerPositionValue) {
      if (window.__belotCutAnimationRunning) {
        return;
      }

      window.__belotCutAnimationRunning = true;

      const root = button.closest('[data-cutting-root]');
      const deck = root ? root.querySelector('[data-cutting-deck]') : null;
      const timerWrap = root ? root.querySelector('[data-cutting-timer-wrap]') : null;
      const title = root ? root.querySelector('[data-cutting-title]') : null;
      const animationLayer = root ? root.querySelector('[data-cutting-animation-layer]') : null;

      if (!root || !deck || !animationLayer) {
        window.__belotCutAnimationRunning = false;

        if (window.confirmCutAndRender) {
          window.confirmCutAndRender(cutIndex);
        }

        return;
      }

      ${buildSeatTargetRuntimeHelpers()}

      function normalizeBottomSeatAfterCutSelection() {
        const bottomSeatRoot = document.querySelector('[data-bidding-seat-root="bottom"]');

        if (!bottomSeatRoot) {
          return;
        }

        bottomSeatRoot.style.gap = '0';

        const bottomSeatCard = bottomSeatRoot.firstElementChild;
        if (bottomSeatCard) {
          bottomSeatCard.style.border = '3px solid rgba(255,255,255,0.12)';
          bottomSeatCard.style.boxShadow = '0 12px 24px rgba(0,0,0,0.22)';
        }

        const cuttingProgressBar = bottomSeatRoot.querySelector('[data-cutting-progress-bar]');
        const cuttingProgressWrap = cuttingProgressBar ? cuttingProgressBar.parentElement : null;

        if (cuttingProgressBar) {
          cuttingProgressBar.style.opacity = '0';
          cuttingProgressBar.style.width = '0%';
        }

        if (cuttingProgressWrap) {
          cuttingProgressWrap.style.opacity = '0';
          cuttingProgressWrap.style.transform = 'translateY(-4px)';
          cuttingProgressWrap.style.pointerEvents = 'none';
          cuttingProgressWrap.style.transition = 'opacity 0.15s linear, transform 0.15s ease';
        }
      }

      normalizeBottomSeatAfterCutSelection();

      const cards = Array.from(deck.querySelectorAll('[data-cut-card-index]'));
      const leftCards = cards.filter((card) => Number(card.dataset.cutCardIndex) < cutIndex);
      const rightCards = cards.filter((card) => Number(card.dataset.cutCardIndex) >= cutIndex);

      deck.style.pointerEvents = 'none';
      animationLayer.innerHTML = '';

      if (timerWrap) {
        timerWrap.style.opacity = '0';
        timerWrap.style.transform = 'translateY(-6px)';
      }

      if (title) {
        title.textContent = 'ЦЕПЕНЕ...';
      }

      cards.forEach((card) => {
        card.disabled = true;
        card.style.transition = 'transform 0.56s ease, filter 0.24s ease, opacity 0.2s linear';
        card.style.filter = 'drop-shadow(0 10px 16px rgba(0,0,0,0.16))';
      });

      const leftMid = (leftCards.length - 1) / 2;
      const rightMid = (rightCards.length - 1) / 2;

      leftCards.forEach((card, packetIndex) => {
        const packetOffset = packetIndex - leftMid;
        const splitX = -230 + packetOffset * 13;
        const splitY = Math.abs(packetOffset) * 1.4 - 10;
        const splitRotate = -11 + packetOffset * 0.75;

        card.style.transform =
          'translateX(' +
          splitX +
          'px) translateY(calc(-50% + ' +
          splitY +
          'px)) rotate(' +
          splitRotate +
          'deg)';

        card.style.zIndex = String(140 + packetIndex);
      });

      rightCards.forEach((card, packetIndex) => {
        const packetOffset = packetIndex - rightMid;
        const splitX = 230 + packetOffset * 13;
        const splitY = Math.abs(packetOffset) * 1.4 - 10;
        const splitRotate = 11 + packetIndex * 0.75;

        card.style.transform =
          'translateX(' +
          splitX +
          'px) translateY(calc(-50% + ' +
          splitY +
          'px)) rotate(' +
          splitRotate +
          'deg)';

        card.style.zIndex = String(240 + packetIndex);
      });

      setTimeout(() => {
        if (title) {
          title.textContent = 'СЪБИРАНЕ...';
        }

        cards.forEach((card, packetIndex) => {
          const stackX = (packetIndex % 4 - 1.5) * 2.2;
          const stackY = (packetIndex % 6) * -0.35;
          const stackRotate = (packetIndex % 3 - 1) * 0.55;

          card.style.transition = 'transform 0.46s ease, filter 0.22s ease, opacity 0.2s linear';
          card.style.transform =
            'translateX(' +
            stackX +
            'px) translateY(calc(-50% + ' +
            stackY +
            'px)) rotate(' +
            stackRotate +
            'deg)';

          card.style.zIndex = String(340 + packetIndex);
          card.style.filter = 'none';
        });
      }, 560);

      setTimeout(() => {
        if (title) {
          title.textContent = 'РАЗДАВАНЕ...';
        }

        cards.forEach((card) => {
          card.style.opacity = '0';
        });

        const dealMarkup = ${safeDealCardHtml};
        const targets = getSeatTargets(root);

        function createDealCard(orderIndex) {
          const cardNode = document.createElement('div');
          cardNode.style.position = 'absolute';
          cardNode.style.left = '50%';
          cardNode.style.top = '50%';
          cardNode.style.width = 'clamp(72px, 5.2vw, 90px)';
          cardNode.style.height = 'clamp(108px, 7.9vw, 136px)';
          cardNode.style.pointerEvents = 'none';
          cardNode.style.zIndex = String(700 + orderIndex);
          cardNode.style.transform =
            'translate(-50%, -50%) translate(0px, 0px) rotate(0deg) scale(1)';
          cardNode.style.transition =
            'transform 0.90s ease, opacity 0.24s linear, filter 0.22s ease';
          cardNode.style.filter = 'drop-shadow(0 3px 6px rgba(0,0,0,0.08))';
          cardNode.innerHTML = dealMarkup;
          animationLayer.appendChild(cardNode);
          return cardNode;
        }

        function launchCard(cardNode, targetKey, spreadOffset, cardInPacketIndex, packetSize) {
          const target = targets[targetKey];
          const centeredOffset = cardInPacketIndex - (packetSize - 1) / 2;

          const extraX =
            targetKey === 'left'
              ? -spreadOffset * 7
              : targetKey === 'right'
                ? spreadOffset * 7
                : centeredOffset * 14;

          const extraY =
            targetKey === 'top'
              ? -spreadOffset * 5 + centeredOffset * -3
              : targetKey === 'bottom'
                ? spreadOffset * 5 + centeredOffset * 3
                : centeredOffset * 12;

          const extraRotate =
            targetKey === 'bottom'
              ? centeredOffset * 4
              : targetKey === 'top'
                ? centeredOffset * -4
                : centeredOffset * 3;

          const scale = targetKey === 'bottom' ? 1 : 0.9;
          const baseRotate = getSeatBaseRotate(targetKey);

          requestAnimationFrame(() => {
            cardNode.style.transform =
              'translate(-50%, -50%) translate(' +
              (target.x + extraX) +
              'px, ' +
              (target.y + extraY) +
              'px) rotate(' +
              (baseRotate + extraRotate) +
              'deg) scale(' +
              scale +
              ')';
          });
        }

        function dealPacketToSeat(targetKey, packetSize, startDelay, baseOrderIndex, seatIndex) {
          const seatDelay = seatIndex * 300;

          for (let i = 0; i < packetSize; i += 1) {
            const orderIndex = baseOrderIndex + i;
            const cardNode = createDealCard(orderIndex);
            const spreadOffset = Math.floor(orderIndex / 4);
            const innerDelay = i * 45;

            setTimeout(() => {
              launchCard(cardNode, targetKey, spreadOffset, i, packetSize);
            }, startDelay + seatDelay + innerDelay);

            setTimeout(() => {
              cardNode.style.opacity = '0';
            }, startDelay + seatDelay + innerDelay + 520);

            setTimeout(() => {
              cardNode.remove();
            }, startDelay + seatDelay + innerDelay + 820);
          }

          return startDelay + seatDelay + (packetSize - 1) * 45;
        }

        const seatOrder = getSeatOrderAfterDealerCounterClockwiseRuntime(dealerPositionValue);

        let timeline = 0;
        let dealtOrderIndex = 0;

        seatOrder.forEach((seatKey, seatIndex) => {
          dealPacketToSeat(seatKey, 3, timeline, dealtOrderIndex, seatIndex);
          dealtOrderIndex += 3;
        });

        timeline += 980;

        seatOrder.forEach((seatKey, seatIndex) => {
          dealPacketToSeat(seatKey, 2, timeline, dealtOrderIndex, seatIndex);
          dealtOrderIndex += 2;
        });

        timeline += 900;

        setTimeout(() => {
          window.__belotCutAnimationRunning = false;

          if (window.confirmCutAndRender) {
            window.confirmCutAndRender(cutIndex);
          }
        }, timeline + 420);
      }, 1060);
    };
  `
}

export function buildCutClickHandler(index, isEnabled, dealCardHtml, dealerPosition) {
  if (!isEnabled) {
    return 'return false;'
  }

  const safeDealerPosition = JSON.stringify(dealerPosition)

  return escapeHtmlAttribute(`
    ${buildCutAnimationRunnerScript(dealCardHtml)}
    window.__belotRunCutAnimation(this, ${index}, ${safeDealerPosition});
  `)
}

export function buildAutoStartCutHandler(cutIndex, dealCardHtml, dealerPosition, cuttingPlayer) {
  const safeDealerPosition = JSON.stringify(dealerPosition)
  const safeCuttingPlayer = JSON.stringify(cuttingPlayer)

  return escapeHtmlAttribute(`
    const root = this.closest('[data-cutting-root]');
    if (!root) {
      return;
    }

    const autoCutKey =
      ${safeCuttingPlayer} +
      '|' +
      ${safeDealerPosition} +
      '|' +
      String(${cutIndex});

    if (root.dataset.autoCutStarted === autoCutKey) {
      return;
    }

    if (window.__belotCutAnimationRunning) {
      return;
    }

    root.dataset.autoCutStarted = autoCutKey;

    const startAnimation = () => {
      const deck = root.querySelector('[data-cutting-deck]');
      const cardButton = deck
        ? deck.querySelector('[data-cut-card-index="${cutIndex}"]')
        : null;

      if (!cardButton) {
        root.dataset.autoCutStarted = '';
        if (window.confirmCutAndRender) {
          window.confirmCutAndRender(${cutIndex});
        }
        return;
      }

      ${buildCutAnimationRunnerScript(dealCardHtml)}
      window.__belotRunCutAnimation(cardButton, ${cutIndex}, ${safeDealerPosition});
    };

    setTimeout(startAnimation, 550);
  `)
}