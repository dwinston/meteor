////////////////////////////////////////////////////////////////////////////////
// Resolver
////////////////////////////////////////////////////////////////////////////////

// XXX the whole resolver heavily relies on these statements to be true:
// - every unit version ever used was added to the resolver with addUnitVersion
// - every constraint ever used was instantiated with getConstraint
// - every constraint was added exactly once
// - every unit version was added exactly once
// - if two unit versions are the same, their refs point at the same object
// - if two constraints are the same, their refs point at the same object
ConstraintSolver.Resolver = function () {
  var self = this;

  // Maps unit name string to an array of version definitions
  self.unitsVersions = {};

  // Maps unit name string to the greatest version string we have
  self._latestVersion = {};

  // Refs to all constraints. Mapping String -> instance
  self._constraints = {};
};

ConstraintSolver.Resolver.prototype.addUnitVersion = function (unitVersion) {
  var self = this;

  check(unitVersion, ConstraintSolver.UnitVersion);

  if (! _.has(self.unitsVersions, unitVersion.name)) {
    self.unitsVersions[unitVersion.name] = [];
    self._latestVersion[unitVersion.name] = unitVersion.version;
  }

  self.unitsVersions[unitVersion.name].push(unitVersion);

  if (semver.lt(self._latestVersion[unitVersion.name], unitVersion.version))
    self._latestVersion[unitVersion.name] = unitVersion.version;
};

// name - String - "someUnit"
// versionConstraint - String - "=1.2.3" or "2.1.0"
ConstraintSolver.Resolver.prototype.getConstraint =
  function (name, versionConstraint) {
  var self = this;

  check(name, String);
  check(versionConstraint, String);

  var idString = JSON.stringify([name, versionConstraint]);

  if (_.has(self._constraints, idString))
    return self._constraints[idString];

  return self._constraints[idString] =
    new ConstraintSolver.Constraint(name, versionConstraint);
};

ConstraintSolver.Resolver.prototype.resolve =
  function (dependencies, constraints, choices, options) {
  var self = this;

  constraints = constraints || [];
  choices = choices || [];
  options = _.extend({
    costFunction: function (choices) { return 0; },
    estimateCostFunction: function (state) {
      return 0;
    }
  }, options);

  dependencies = _.uniq(dependencies);
  constraints = _.uniq(constraints);

  var rootDependencies = _.clone(dependencies);

  // create a fake unit version to represnt the app or the build target
  var appUV = new ConstraintSolver.UnitVersion("target", "1.0.0", "0.0.0");
  appUV.dependencies = dependencies;
  appUV.constraints = constraints;

  var startState = self._propagateExactTransDeps(appUV, dependencies, constraints, []);
  startState.choices = _.filter(startState.choices, function (uv) { return uv.name !== "target"; });

  if (options.stopAfterFirstPropagation)
    return startState.choices;

  var pq = new PriorityQueue();
  var opts = { rootDependencies: rootDependencies };
  var costFunction = options.costFunction;
  var estimateCostFunction = options.estimateCostFunction;

  pq.push(startState, [estimateCostFunction(startState, opts), 0]);

  var someError = null;
  var solution = null;
  while (! pq.empty()) {
    var currentState = pq.pop();
    var tentativeCost =
      costFunction(currentState.choices, opts) +
      estimateCostFunction(currentState, opts);

    if (tentativeCost === Infinity)
      break;

    if (_.isEmpty(currentState.dependencies)) {
      solution = currentState.choices;
      break;
    }

    var neighborsObj = self._stateNeighbors(currentState);

    if (! neighborsObj.success) {
      someError = someError || neighborsObj.failureMsg;
    } else {
      _.each(neighborsObj.neighbors, function (state) {
        var tentativeCost =
          costFunction(state.choices, opts) +
          estimateCostFunction(state, opts);

        pq.push(state, [tentativeCost, -state.choices.length]);
      });
    }
  }

  if (solution)
    return solution;

  // XXX should be much much better
  if (someError)
    throw new Error(someError);

  throw new Error("Couldn't resolve, I am sorry");
};

// dependencies: [String] - remaining dependencies
// constraints: [ConstraintSolver.Constraint] - constraints to satisfy
// choices: [ConstraintSolver.UnitVersion] - current fixed set of choices
//
// returns {
//   success: Boolean,
//   failureMsg: String,
//   choices: [ConstraintSolver.UnitVersion]
// }
//
// NOTE: assumes that exact dependencies are already propagated
ConstraintSolver.Resolver.prototype._stateNeighbors =
  function (state) {
  var self = this;

  var dependencies = state.dependencies;
  var constraints = state.constraints;
  var choices = state.choices;

  var candidateName = dependencies[0];
  dependencies = dependencies.slice(1);

  var candidateConstraints = _.filter(constraints, function (c) {
    return c.name === candidateName;
  });
  var candidateVersions =
    _.filter(self.unitsVersions[candidateName], function (uv) {
      return unitVersionDoesntValidateConstraints(uv, candidateConstraints);
    });

  if (_.isEmpty(candidateVersions))
    return { success: false,
             failureMsg: "Cannot choose satisfying versions of package -- "
                         + candidateName };

  var lastInvalidNeighbor = null;

  var neighbors = _.chain(candidateVersions).map(function (uv) {
    var nDependencies = _.clone(dependencies);
    var nConstraints = _.clone(constraints);
    var nChoices = _.clone(choices);

    nChoices.push(uv);
    var propagatedExactTransDeps =
      self._propagateExactTransDeps(uv, nDependencies, nConstraints, nChoices);

    nDependencies = propagatedExactTransDeps.dependencies;
    nConstraints = propagatedExactTransDeps.constraints;
    nChoices = propagatedExactTransDeps.choices;

    return {
      dependencies: nDependencies,
      constraints: nConstraints,
      choices: nChoices
    };
  }).filter(function (state) {
    var isValid =
      choicesDontValidateConstraints(state.choices, state.constraints);

    if (! isValid)
      lastInvalidNeighbor = state;

    return isValid;
  }).value();

  if (! neighbors.length)
    return { success: false,
             failureMsg: "None of the versions unit produces a sensible result -- "
               + candidateName,
             triedUnitVersions: candidateVersions,
             lastInvalidNeighbor: lastInvalidNeighbor };

  return { success: true, neighbors: neighbors };
};

// Propagates exact dependencies (depencies which have exact constraints) from
// the given unit version taking into account the existing set of dependencies
// and constraints.
// Assumes that the unit versions graph without passed unit version is already
// propagated (i.e. doesn't try to propagate anything not related to the passed
// unit version).
ConstraintSolver.Resolver.prototype._propagateExactTransDeps =
  function (uv, dependencies, constraints, choices) {
  var self = this;

  // XXX representing a queue as an array with push/shift operations is not
  // efficient as Array.shift is O(N). Replace if it becomes a problem.
  var queue = [];
  // Boolean map to avoid adding the same stuff to queue over and over again.
  // Keeps the time complexity the same but can save some memory.
  var isEnqueued = {};

  queue.push(uv);
  isEnqueued[uv.name] = true;

  while (queue.length > 0) {
    uv = queue[0];
    queue.shift();

    choices = _.union(choices, [uv]);

    var exactTransitiveDepsVersions =
      uv.exactTransitiveDependenciesVersions(self);
    var inexactTransitiveDeps = uv.inexactTransitiveDependencies(self);
    var transitiveConstraints = _.chain(exactTransitiveDepsVersions).union([uv])
      .map(function (uv) { return uv.constraints; }).flatten().uniq().value();

    dependencies = _.union(dependencies, inexactTransitiveDeps);
    constraints = _.union(constraints, transitiveConstraints);
    choices = _.union(choices, exactTransitiveDepsVersions);

    // Since exact transitive deps are put into choices, there is no need to
    // keep them in dependencies.
    dependencies = _.difference(dependencies, _.pluck(choices, "name"));

    // There could be new combination of exact constraint/dependency outgoing
    // from existing state and the new node.
    // We don't need to look for all previously considered combinations.
    // Looking for newNode.dependencies+exact constraints and
    // newNode.exactConstraints+dependencies is enough.
    var exactDeps = _.chain(uv.dependencies).map(function (dep) {
      return _.find(constraints, function (c) {
        return c.name === uv.name && c.exact;
      });
    }).filter(_.identity).map(function (c) {
      return c.getSatisfyingUnitVersion(self);
    }).union(_.chain(uv.constraints).filter(function (c) { return c.exact; })
              .map(function (c) { return c.getSatisfyingUnitVersion(self); })
              .value()
            ).difference(choices).value();

    // Enqueue all new exact dependencies.
    _.each(exactDeps, function (dep) {
      if (_.has(isEnqueued, dep.name))
        return;
      queue.push(dep);
      isEnqueued[dep.name] = true;
    });
  }

  return {
    dependencies: dependencies,
    constraints: constraints,
    choices: choices
  };
};

unitVersionDoesntValidateConstraints = function (uv, constraints) {
  return _.all(constraints, function (c) {
    return c.name !== uv.name || c.isSatisfied(uv);
  });
};

var choicesDontValidateConstraints = function (choices, constraints) {
  var constraintsByName = _.groupBy(constraints, 'name');
  return _.all(choices, function (uv) {
    return unitVersionDoesntValidateConstraints(
      uv, constraintsByName[uv.name] || []);
  });
};

////////////////////////////////////////////////////////////////////////////////
// UnitVersion
////////////////////////////////////////////////////////////////////////////////

ConstraintSolver.UnitVersion = function (name, unitVersion, ecv) {
  var self = this;

  check(name, String);
  check(unitVersion, String);
  check(ecv, String);
  check(self, ConstraintSolver.UnitVersion);

  self.name = name;
  self.version = unitVersion;
  // array of Strings - names of dependencies
  self.dependencies = [];
  // array of ConstraintSolver.Constraint's
  self.constraints = [];
  // a string in a form of "1.2.0"
  self.ecv = ecv;
};

_.extend(ConstraintSolver.UnitVersion.prototype, {
  addDependency: function (name) {
    var self = this;

    check(name, String);
    if (_.contains(self.dependencies, name))
      throw new Error("Dependency already exists -- " + name);
    self.dependencies.push(name);
  },
  addConstraint: function (constraint) {
    var self = this;

    check(constraint, ConstraintSolver.Constraint);
    if (_.contains(self.constraints, constraint))
      throw new Error("Constraint already exists -- " + constraint.toString());

    self.constraints.push(constraint);
  },
  exactConstraints: function () {
    var self = this;
    return _.filter(self.constraints, function (c) { return c.exact; });
  },
  looseConstraints: function () {
    var self = this;
    return _.filter(self.constraints, function (c) { return !c.exact; });
  },

  // Returns a list of transitive exact constraints, those could be found as
  // transitive dependencies.
  _exactTransitiveConstraints: function (resolver) {
    var self = this;

    // Get all dependencies we depend on and have constraints to pick an exact
    // version simultaneously as constraints.
    var exactDeps = _.filter(self.exactConstraints(), function (c) {
      return _.contains(self.dependencies, c.name);
    });

    // Merge all their's transitive exact dependencies
    var exactTransitiveConstraints = _.clone(exactDeps);

    _.each(exactDeps, function (c) {
      var unitVersion = c.getSatisfyingUnitVersion(resolver);
      // TODO: error handling in case a satisfying dependency wasn't found
      // xcxc
      if (!unitVersion)
        throw new Error("No unit version was found for the constraint -- " + c.toString());

      // Collect the transitive dependencies of the direct exact dependencies.
      exactTransitiveConstraints = _.union(exactTransitiveConstraints,
                unitVersion._exactTransitiveConstraints(resolver));
    });

    return exactTransitiveConstraints;
  },

  exactTransitiveDependenciesVersions: function (resolver) {
    var self = this;
    return _.map(self._exactTransitiveConstraints(resolver), function (c) {
      return c.getSatisfyingUnitVersion(resolver);
    });
  },
  inexactTransitiveDependencies: function (resolver) {
    var self = this;
    var exactTransitiveConstraints = self._exactTransitiveConstraints(resolver);

    return _.chain(exactTransitiveConstraints).map(function (c) {
      var unitVersion = c.getSatisfyingUnitVersion(resolver);
      // TODO: error handling in case unitVersion wasn't found

      return unitVersion.dependencies;
    }).flatten().union(self.dependencies).uniq()
      .difference(_.pluck(exactTransitiveConstraints, "name")).value();
  },
  toString: function () {
    var self = this;
    return self.name + "@" + self.version;
  }
});

////////////////////////////////////////////////////////////////////////////////
// Constraint
////////////////////////////////////////////////////////////////////////////////

// Can be called either:
//    new PackageVersion.Constraint("packageA", "=2.1.0")
// or:
//    new PackageVersion.Constraint("pacakgeA@=2.1.0")
ConstraintSolver.Constraint = function (name, versionString) {
  var self = this;

  if (versionString) {
    _.extend(self, PackageVersion.parseVersionConstraint(versionString));
    self.name = name;
  } else {
    _.extend(self, PackageVersion.parseConstraint(name));
  }
};

ConstraintSolver.Constraint.prototype.toString = function () {
  var self = this;
  return self.name + "@" + (self.exact ? "=" : "") + self.version;
};

var semver = Npm.require('semver');

ConstraintSolver.Constraint.prototype.isSatisfied = function (unitVersion) {
  var self = this;
  check(unitVersion, ConstraintSolver.UnitVersion);

  if (self.exact)
    return self.version === unitVersion.version;

  return semver.lte(self.version, unitVersion.version) &&
    semver.lte(unitVersion.ecv, self.version);
};

// Returns any unit version satisfying the constraint in the resolver
ConstraintSolver.Constraint.prototype.getSatisfyingUnitVersion =
  function (resolver) {
  var self = this;
  var unitVersion = _.find(resolver.unitsVersions[self.name],
                           _.bind(self.isSatisfied, self));
  return unitVersion;
};


////////////////////////////////////////////////////////////////////////////////
// ConstraintsList
////////////////////////////////////////////////////////////////////////////////
// A persistent data-structure that keeps references to Constraint objects
// arranged by the "name" field of Constraint, exact field and version.
var mori = Npm.require('mori');
ConstraintSolver.ConstraintsList = function (prev) {
  var self = this;

  if (prev) {
    self.byName = prev.byName;
    self.length = prev.length;
  } else {
    self.byName = mori.hash_map();
    self.length = 0;
  }
};

ConstraintSolver.ConstraintsList.prototype.contains = function (c) {
  var self = this;
  if (! mori.has_key(self.byName, c.name))
    return false;

  var bn = mori.get(self.byName, c.name);
  var constraints = mori.get(bn, c.exact ? "exact" : "inexact");
  return mori.has_key(constraints, c.version);
};

// returns a new version containing passed constraint
ConstraintSolver.ConstraintsList.prototype.push = function (c) {
  var self = this;

  if (self.contains(c)) {
    return self;
  }

  var newList = new ConstraintSolver.ConstraintsList(self);

  // create a record or update the lookup table
  if (! mori.has_key(self.byName, c.name)) {
    var exactMap = mori.hash_map();
    var inexactMap = mori.hash_map();

    if (c.exact) {
      exactMap = mori.assoc(exactMap, c.version, c);
    } else {
      inexactMap = mori.assoc(inexactMap, c.version, c);
    }

    var bn = mori.hash_map("exact", exactMap, "inexact", inexactMap);
    newList.byName = mori.assoc(newList.byName, c.name, bn);
  } else {
    var exactStr = c.exact ? "exact" : "inexact";

    var bn = mori.get(newList.byName, c.name);
    var constraints = mori.get(bn, exactStr);
    constraints = mori.assoc(constraints, c.version, c);
    bn = mori.assoc(bn, exactStr, constraints);
    newList.byName = mori.assoc(newList.byName, c.name, bn);
  }

  newList.length++;

  return newList;
};

ConstraintSolver.ConstraintsList.prototype.forPackage = function (name) {
  var self = this;
  return mori.get(self.byName, name);
};

////////////////////////////////////////////////////////////////////////////////
// DependenciesList
////////////////////////////////////////////////////////////////////////////////
// A persistent data-structure that wrapps persistent dictionary

ConstraintSolver.DependenciesList = function (prev) {
  var self = this;

  if (prev) {
    self.map = prev.byName;
  } else {
    self.map = mori.hash_map();
  }
};

ConstraintSolver.DependenciesList.prototype.contains = function (d) {
  var self = this;
  return mori.has_key(self.map, d);
};

// returns a new version containing passed dependency
ConstraintSolver.DependenciesList.prototype.push = function (d) {
  var self = this;

  if (self.contains(d)) {
    return self;
  }

  var newList = new ConstraintSolver.DependenciesList(self);
  newList.map = mori.assoc(self.map, d, d);
  return newList;
};

ConstraintSolver.DependenciesList.prototype.remove = function (d) {
  var self = this;
  var newList = new ConstraintSolver.DependenciesList(self);
  newList.map = mori.dissoc(self.map, d);

  return newList;
};

ConstraintSolver.DependenciesList.prototype.peek = function () {
  var self = this;
  return mori.peek(mori.last(self.map));
};



