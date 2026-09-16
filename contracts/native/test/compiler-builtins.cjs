// Test-only implementations of the four compiler-rt shifts missing in VeRT
// 0.3.24. These operate on WASM memory; no contract logic or storage is mocked.
const { VM } = require('@proton/vert');
const originalFrom = VM.from;
VM.from = function (...args) {
  const vm = originalFrom.apply(this, args);
  const read = (lo, hi) => BigInt.asUintN(64, lo) | (BigInt.asUintN(64, hi) << 64n);
  const write = (ptr, value) => {
    const out = new DataView(vm.memory.buffer);
    value = BigInt.asUintN(128, value);
    out.setBigUint64(ptr, BigInt.asUintN(64, value), true);
    out.setBigUint64(ptr + 8, value >> 64n, true);
  };
  // Vert awaits the WASM bytes before instantiation, so these imports are set
  // synchronously before the module captures them.
  vm.imports.env.__ashlti3 = (ptr, lo, hi, shift) => write(ptr, read(lo, hi) << BigInt(shift));
  vm.imports.env.__lshlti3 = vm.imports.env.__ashlti3;
  vm.imports.env.__lshrti3 = (ptr, lo, hi, shift) => write(ptr, read(lo, hi) >> BigInt(shift));
  vm.imports.env.__ashrti3 = (ptr, lo, hi, shift) => write(ptr, BigInt.asIntN(128, read(lo, hi)) >> BigInt(shift));
  return vm;
};
