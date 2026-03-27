export function buildSeatTargetRuntimeHelpers() {
  return `
    function getSeatOrderAfterDealerCounterClockwiseRuntime(currentDealerPosition) {
      const order = ['bottom', 'right', 'top', 'left'];
      const dealerIndex = order.indexOf(currentDealerPosition);

      if (dealerIndex === -1) {
        return ['right', 'top', 'left', 'bottom'];
      }

      return [
        order[(dealerIndex + 1) % 4],
        order[(dealerIndex + 2) % 4],
        order[(dealerIndex + 3) % 4],
        order[(dealerIndex + 4) % 4],
      ];
    }

    function getRelativeSeatTarget(rootNode, seatKey) {
      if (!rootNode) {
        return null;
      }

      const tableNode = rootNode.closest('.table');
      const animationLayer = rootNode.querySelector('[data-cutting-animation-layer]');
      const seatTargetNode = tableNode
        ? tableNode.querySelector('[data-seat-animation-target="' + seatKey + '"]')
        : null;

      if (!animationLayer || !seatTargetNode) {
        return null;
      }

      const layerRect = animationLayer.getBoundingClientRect();
      const seatRect = seatTargetNode.getBoundingClientRect();

      return {
        x: seatRect.left + seatRect.width / 2 - (layerRect.left + layerRect.width / 2),
        y: seatRect.top + seatRect.height / 2 - (layerRect.top + layerRect.height / 2),
      };
    }

    function getSeatTargets(rootNode) {
      const fallbackTargets = {
        left: { x: -340, y: -10, rotate: -16 },
        top: { x: 0, y: -210, rotate: 0 },
        right: { x: 340, y: -10, rotate: 16 },
        bottom: { x: 0, y: 206, rotate: 0 },
      };

      return {
        left: {
          ...(fallbackTargets.left),
          ...(getRelativeSeatTarget(rootNode, 'left') || {}),
        },
        top: {
          ...(fallbackTargets.top),
          ...(getRelativeSeatTarget(rootNode, 'top') || {}),
        },
        right: {
          ...(fallbackTargets.right),
          ...(getRelativeSeatTarget(rootNode, 'right') || {}),
        },
        bottom: {
          ...(fallbackTargets.bottom),
          ...(getRelativeSeatTarget(rootNode, 'bottom') || {}),
        },
      };
    }

    function getSeatBaseRotate(seatKey) {
      if (seatKey === 'left') {
        return -16;
      }

      if (seatKey === 'right') {
        return 16;
      }

      return 0;
    }
  `
}