// Path2D stand-in for node: records nothing, enough for the geometry cache.
class Path2DStub {
	moveTo() {}
	lineTo() {}
	quadraticCurveTo() {}
	closePath() {}
	arc() {}
}
(globalThis as unknown as { Path2D: unknown }).Path2D ??= Path2DStub;
