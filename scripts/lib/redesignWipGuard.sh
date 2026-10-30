# redesignWipGuard.sh — споделена "Redesign WIP guard" проверка за всички
# production deploy entrypoint-и (source-ва се, не се изпълнява директно):
#   scripts/deploy-production.sh           (smart controller)
#   scripts/deploy-frontend-production.sh  (frontend worker / директен entrypoint)
#   scripts/deploy-backend-production.sh   (backend worker / директен entrypoint)
#   scripts/deployFrontendAtomic.sh        (npm run deploy:frontend)
#
# feature/mobile-redesign носи ПРОСЛЕДЯВАН sentinel файл .redesign-wip в
# корена на repo-то. Проверката гледа TREE-то на самия commit за
# публикуване (git ls-tree), не името на branch-а — работи еднакво при
# branch и detached HEAD. Допълнително (не вместо това) отказва и когато
# файлът съществува в working directory-то. Fail-closed: всяка git грешка
# -> STOP вместо предположение.
#
# Изисква извикващият скрипт да е дефинирал log() и fail() (fail() трябва
# да прекратява процеса). Извиква се ПРЕДИ build, backup, migrations,
# restart, publish или каквато и да е промяна по production.

REDESIGN_WIP_SENTINEL=".redesign-wip"

# assert_target_not_redesign_wip <repo_dir> <commit_sha>
assert_target_not_redesign_wip() {
  local repo_dir="${1:-}" commit="${2:-}" match
  if [ -z "$repo_dir" ] || [ -z "$commit" ]; then
    fail "Redesign WIP guard: липсва repo директория или target commit (repo=\"$repo_dir\" commit=\"$commit\") — STOP."
  fi
  if ! git -C "$repo_dir" cat-file -e "${commit}^{commit}" 2>/dev/null; then
    fail "Redesign WIP guard: target \"$commit\" не е валиден commit в $repo_dir — не мога да потвърдя, че не е незавършеният редизайн. STOP."
  fi
  if ! match="$(git -C "$repo_dir" ls-tree --full-tree --name-only "$commit" -- "$REDESIGN_WIP_SENTINEL")"; then
    fail "Redesign WIP guard: git ls-tree се провали за target $commit — не мога да потвърдя, че target-ът не е незавършеният редизайн. STOP."
  fi
  if [ -n "$match" ]; then
    fail "Redesign WIP guard: target ${commit:0:7} съдържа $REDESIGN_WIP_SENTINEL — това е незавършеният mobile redesign (feature/mobile-redesign), не production commit. Нищо не е build-нато, мигрирано, backup-нато, публикувано или рестартирано. Върни checkout-а на v2-clean-architecture или hotfix commit без $REDESIGN_WIP_SENTINEL."
  fi
  if [ -e "$repo_dir/$REDESIGN_WIP_SENTINEL" ]; then
    fail "Redesign WIP guard: $REDESIGN_WIP_SENTINEL съществува в working directory-то ($repo_dir), въпреки че target ${commit:0:7} не го съдържа — смесено/незавършено състояние. STOP."
  fi
  log "Redesign WIP guard: target ${commit:0:7} не съдържа $REDESIGN_WIP_SENTINEL — OK"
}
