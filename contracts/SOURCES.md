# Sources of the measured contracts

The contracts measured in Phase 0 and Phase 1 are public contracts written by others, ported to the
GenVM v0.2 runner that Bradbury accepts. A port changes syntax only; the logic is the same as the
original. The contracts in `contracts/dv/` were written for this project.

| Port | Original | Commit | License of the original |
|---|---|---|---|
| `contracts/bradbury/wizard_of_coin.py` | [genlayerlabs/genlayer-studio, `examples/contracts/wizard_of_coin.py`](https://github.com/genlayerlabs/genlayer-studio/blob/c94072951e483510329670aa427fba3fa6944f45/examples/contracts/wizard_of_coin.py) | c94072951e483510329670aa427fba3fa6944f45 | MIT |
| `contracts/bradbury/company_naming.py` | [genlayerlabs/genlayer-studio, `tests/integration/icontracts/contracts/company_naming.py`](https://github.com/genlayerlabs/genlayer-studio/blob/c94072951e483510329670aa427fba3fa6944f45/tests/integration/icontracts/contracts/company_naming.py) | c94072951e483510329670aa427fba3fa6944f45 | MIT |
| `contracts/bradbury/tribunal.py` (not redistributed) | [ebukaarcryppted-git/GenAntiTrust, `contracts/tribunal.py`](https://github.com/ebukaarcryppted-git/GenAntiTrust/blob/e6ade9441d05398928103807b45ccc4697f0f4b8/contracts/tribunal.py) | e6ade9441d05398928103807b45ccc4697f0f4b8 | none |

## What each port changes

- `wizard_of_coin.py`: header pinned to the runner `1j12s63...`; the line `# v0.3.0` (GenVM v0.3
  version marker) removed; `import genlayer as gl` -> `from genlayer import *`;
  `gl.contract.Contract` -> `gl.Contract`.
- `company_naming.py`: header pinned to the runner `1j12s63...`; `import genlayer as gl` +
  `from genlayer.types import *` -> `from genlayer import *`; `gl.contract.Contract` ->
  `gl.Contract`; `gl.vm.run_nondet_default` -> `gl.vm.run_nondet` (in v0.2 `run_nondet` is the
  sandboxed variant, the same semantics).
- `tribunal.py`: the replacements listed in `contracts/bradbury/port_tribunal.py`.

## genlayer-studio (MIT)

`wizard_of_coin.py` and `company_naming.py` are modified copies of files of genlayer-studio,
distributed under its license:

    MIT License

    Copyright (c) 2024 GenLayer Labs Corp.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## GenAntiTrust tribunal (no license: not redistributed)

The GenAntiTrust repository has no license, so neither its contract nor the port is copied here.
`contracts/bradbury/port_tribunal.py` downloads the original at the commit above, checks its
SHA-256, applies the port and checks the result:

    python contracts/bradbury/port_tribunal.py

| File | SHA-256 |
|---|---|
| Original `contracts/tribunal.py` | b89a6066ef20d68edb4a22b7c1f9723e1327770b5c68a18714ece92d5e11f0ef |
| Port `contracts/bradbury/tribunal.py` | e481996ee46532cbfa6ce6f5d24e6117c2d1ee94bde2a85bf0a8029d3dd0b62d |
| Original `tests/direct/test_tribunal.py` | 63273916d2ed3da52c0fb48e50ef781aba043974dd1325dbd4bb91dc4fa06af6 |
| Input `contracts/bradbury/inputs/tribunal_evidence.json` | 9b38654252e88073cf74d4dd2c3e758ff7fabf9fd3826b9361cc9a8462d6fb87 |

The fixed evidence passed to `file_complaint` is the list that the original direct test uses; the
script extracts it from that test.

`harness/contracts.py` carried four lines of that test: the placeholder address of the respondent
and the three evidence records. It is listed in the pre-registration (`window-v3.json`, SHA-256
683f9345d360ddb49fcdb8c5d540372c0cccca5248389b4ebaba9eb907578a3d) and is published with those lines
replaced by markers. `python harness/restore_contracts.py` puts them back from the original test and
checks that SHA-256.

## GenVM prompt templates (Business Source License 1.1: not redistributed)

`harness/genvm_llm.py` is code of this project. It reproduces the behavior of the LLM module of
GenVM ([genlayerlabs/genvm at commit abb71bf891695b737e6a4f5211f4740a3b25543d](https://github.com/genlayerlabs/genvm/tree/abb71bf891695b737e6a4f5211f4740a3b25543d))
and contains no text of GenVM: it reads the equivalence-principle prompt templates at run time from
`reference/genvm/genvm-module-llm.yaml`. That file belongs to genlayerlabs/genvm, under the Business
Source License 1.1, and is not copied here. Its SHA-256 is listed in the pre-registration
(`window-v3.json`), and can be verified against the original:

- Original: [genlayerlabs/genvm, `modules/install/config/genvm-module-llm.yaml`](https://github.com/genlayerlabs/genvm/blob/abb71bf891695b737e6a4f5211f4740a3b25543d/modules/install/config/genvm-module-llm.yaml),
  commit abb71bf891695b737e6a4f5211f4740a3b25543d.
- SHA-256: d1037dc7b97e481e4035c8af2746d0ec0e869950e0232168dd0471347cb5624d
- To run the local module or the hash verification, save it as
  `reference/genvm/genvm-module-llm.yaml`.
