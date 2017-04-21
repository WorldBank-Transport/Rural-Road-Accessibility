'use strict';
import Joi from 'joi';
import Boom from 'boom';
import Promise from 'bluebird';

import db from '../db/';
import { getPresignedUrl, listenForFile } from '../s3/utils';
import { ProjectNotFoundError, ScenarioNotFoundError, DataConflictError } from '../utils/errors';
import Operation from '../utils/operation';
import ServiceRunner from '../utils/service-runner';
import { closeDatabase } from '../services/rra-osm-p2p';

module.exports = [
  {
    path: '/projects/{projId}/scenarios',
    method: 'POST',
    config: {
      validate: {
        params: {
          projId: Joi.number()
        },
        payload: {
          name: Joi.string().required(),
          description: Joi.string(),
          roadNetworkSource: Joi.string().valid('clone', 'new').required(),
          roadNetworkSourceScenario: Joi.number().when('roadNetworkSource', {is: 'clone', then: Joi.required()})
        }
      }
    },
    handler: (request, reply) => {
      const data = request.payload;
      const source = data.roadNetworkSource;
      const sourceScenarioId = data.roadNetworkSourceScenario;

      db('projects')
        .select('status')
        .where('id', request.params.projId)
        .then(projects => {
          if (!projects.length) throw new ProjectNotFoundError();
          //  It's not possible to create scenarios for pending projects.
          if (projects[0].status === 'pending') throw new DataConflictError('Project setup not completed');
        })
        .then(() => {
          // If we're cloning from a different scenario, make sure it exists.
          if (source === 'clone') {
            return db('scenarios')
              .select('id')
              .where('id', sourceScenarioId)
              .where('project_id', request.params.projId)
              .then((scenarios) => {
                if (!scenarios.length) throw new ScenarioNotFoundError();
              });
          }
        })
        .then(() => {
          // Create the scenario base to be able to start an operation for it.
          const info = {
            name: data.name,
            description: data.description || '',
            status: 'pending',
            master: false,
            project_id: request.params.projId,
            created_at: (new Date()),
            updated_at: (new Date())
          };

          return db('scenarios')
            .returning('*')
            .insert(info)
            .then(res => res[0])
            .catch(err => {
              if (err.constraint === 'scenarios_project_id_name_unique') {
                throw new DataConflictError(`Scenario name already in use for this project: ${data.name}`);
              }
              throw err;
            });
        })
        // Start operation and return data to continue.
        .then(scenario => startOperation(request.params.projId, scenario.id).then(op => [op, scenario]))
        .then(data => {
          let [op, scenario] = data;
          if (source === 'clone') {
            return createScenario(request.params.projId, scenario.id, op.getId(), source, {sourceScenarioId})
              .then(() => reply(scenario));
          } else if (source === 'new') {
            return handleRoadNetworkUpload(reply, scenario, op.getId(), source);
          }
        })
        .catch(ProjectNotFoundError, e => reply(Boom.notFound(e.message)))
        .catch(ScenarioNotFoundError, e => reply(Boom.badRequest('Source scenario for cloning not found')))
        .catch(DataConflictError, e => reply(Boom.conflict(e.message)))
        .catch(err => {
          console.log('err', err);
          reply(Boom.badImplementation(err));
        });
    }
  }
];

function startOperation (projId, scId) {
  let op = new Operation(db);
  return op.loadByData('scenario-create', projId, scId)
    .then(op => {
      if (op.isStarted()) {
        throw new DataConflictError('Scenario creation already in progress');
      }
    }, err => {
      // In this case if the operation doesn't exist is not a problem.
      if (err.message.match(/not exist/)) { return; }
      throw err;
    })
    .then(() => {
      let op = new Operation(db);
      return op.start('scenario-create', projId, scId)
        .then(() => op.log('start', {message: 'Operation started'}));
    });
}

function createScenario (projId, scId, opId, source, data) {
  let action = Promise.resolve();
  // In test mode we don't want to start the generation.
  // It will be tested in the appropriate place.
  if (process.env.DS_ENV === 'test') { return action; }

  if (source === 'clone') {
    // We need to close the connection to the source scenario before cloning
    // the database. This needs to be done in this process. The process ran by
    // the service runner won't have access to it.
    action = closeDatabase(projId, data.sourceScenarioId);
  }

  let serviceData = Object.assign({}, {projId, scId, opId, source}, data);

  action.then(() => {
    console.log(`p${projId} s${scId}`, 'createScenario');
    let service = new ServiceRunner('scenario-create', serviceData);

    service.on('complete', err => {
      console.log(`p${projId} s${scId}`, 'createScenario complete');
      if (err) {
        // The operation may not have finished if the error took place outside
        // the promise, or if the error was due to a wrong db connection.
        let op = new Operation(db);
        op.loadById(opId)
          .then(op => {
            if (!op.isCompleted()) {
              return op.log('error', {error: err.message})
                .then(op => op.finish());
            }
          });
      }
    })
    .start();
  });

  return action;
}

// Get the presigned url for file upload and send it to the client.
// Listen for file changes to update the database.
function handleRoadNetworkUpload (reply, scenario, opId, source) {
  const type = 'road-network';
  const fileName = `${type}_${Date.now()}`;
  const filePath = `scenario-${scenario.id}/${fileName}`;

  return getPresignedUrl(filePath)
    .then(presignedUrl => {
      scenario.roadNetworkUpload = {
        fileName: fileName,
        presignedUrl
      };

      return reply(scenario);
    })
    .then(() => listenForFile(filePath))
    .then(record => {
      createScenario(scenario.project_id, scenario.id, opId, source, {roadNetworkFile: fileName});
    });
}
